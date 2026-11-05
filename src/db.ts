import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./config";
import type { ParsedRow, HeaderTotals } from "./parser";
import { calloutTime, ageDaysPrecision } from "./parser";

export type DB = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kols (
  handle        TEXT PRIMARY KEY,
  display_name  TEXT,
  avatar_url    TEXT,
  profile_url   TEXT NOT NULL,
  source        TEXT NOT NULL,            -- leaderboard | config
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL,         -- running | ok | partial | failed
  profiles_total   INTEGER NOT NULL DEFAULT 0,
  profiles_ok      INTEGER NOT NULL DEFAULT 0,
  profiles_failed  INTEGER NOT NULL DEFAULT 0,
  notes            TEXT
);

-- one row per callout. Natural key: handle + token + callout date (age at first
-- sight converted to an absolute UTC date). Matching tolerates +/- 1 day of drift
-- and uses entry MC to tell apart re-callouts of the same token.
CREATE TABLE IF NOT EXISTS callouts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  handle         TEXT NOT NULL REFERENCES kols(handle),
  token          TEXT NOT NULL,
  callout_date   TEXT NOT NULL,           -- YYYY-MM-DD (UTC), estimated
  callout_at     TEXT NOT NULL,           -- ISO timestamp, estimated
  age_precision  TEXT,                    -- minute | hour | day | week | month | date
  age_known      INTEGER NOT NULL DEFAULT 1,
  entry_mc       REAL,
  first_seen_at  TEXT NOT NULL,
  first_run_id   INTEGER REFERENCES runs(id),
  UNIQUE(handle, token, callout_date, entry_mc)
);
CREATE INDEX IF NOT EXISTS idx_callouts_handle ON callouts(handle);

-- one row per callout per scrape; never overwritten
CREATE TABLE IF NOT EXISTS callout_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  callout_id  INTEGER NOT NULL REFERENCES callouts(id),
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  scraped_at  TEXT NOT NULL,
  age_days    REAL,
  age_raw     TEXT,
  tailers     INTEGER,
  pnl_1h      REAL,
  pnl_1d      REAL,
  peak        REAL,
  multiplier  REAL,
  entry_mc    REAL,
  peak_mc     REAL,
  mc_raw      TEXT,
  raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_callout ON callout_snapshots(callout_id, scraped_at);
CREATE INDEX IF NOT EXISTS idx_snap_run ON callout_snapshots(run_id);

CREATE TABLE IF NOT EXISTS reward_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  handle       TEXT NOT NULL,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  scraped_at   TEXT NOT NULL,
  view         TEXT NOT NULL,             -- all | monthly | weekly | daily
  rank         INTEGER,
  rewards      REAL,
  rewards_unit TEXT,                      -- USD | SOL | ?
  raw          TEXT
);
CREATE INDEX IF NOT EXISTS idx_rewards_handle ON reward_snapshots(handle, view, scraped_at);

-- per profile per run: header totals + outcome
CREATE TABLE IF NOT EXISTS profile_snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  handle             TEXT NOT NULL,
  run_id             INTEGER NOT NULL REFERENCES runs(id),
  scraped_at         TEXT NOT NULL,
  status             TEXT NOT NULL,       -- ok | failed
  header_callouts    INTEGER,
  header_tailers     INTEGER,
  header_tail_volume REAL,
  rows_parsed        INTEGER,
  source             TEXT,                -- dom | api
  error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_snap ON profile_snapshots(handle, scraped_at);
`;

export function openDb(file = DB_PATH): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

// ---------- runs ----------
export function startRun(db: DB, notes?: string): number {
  const r = db.prepare(`INSERT INTO runs (started_at, status, notes) VALUES (?, 'running', ?)`).run(nowIso(), notes ?? null);
  return Number(r.lastInsertRowid);
}
export function finishRun(db: DB, id: number, s: { status: string; total: number; ok: number; failed: number; notes?: string }) {
  db.prepare(`UPDATE runs SET finished_at=?, status=?, profiles_total=?, profiles_ok=?, profiles_failed=?, notes=COALESCE(?, notes) WHERE id=?`)
    .run(nowIso(), s.status, s.total, s.ok, s.failed, s.notes ?? null, id);
}

// ---------- kols ----------
export function upsertKol(db: DB, k: { handle: string; displayName?: string | null; avatarUrl?: string | null; profileUrl: string; source: string }) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO kols (handle, display_name, avatar_url, profile_url, source, first_seen_at, last_seen_at)
    VALUES (@handle, @displayName, @avatarUrl, @profileUrl, @source, @ts, @ts)
    ON CONFLICT(handle) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, kols.display_name),
      avatar_url   = COALESCE(excluded.avatar_url, kols.avatar_url),
      last_seen_at = excluded.last_seen_at
  `).run({ handle: k.handle, displayName: k.displayName ?? null, avatarUrl: k.avatarUrl ?? null, profileUrl: k.profileUrl, source: k.source, ts });
}

export function allHandles(db: DB): string[] {
  return db.prepare(`SELECT handle FROM kols ORDER BY handle`).all().map((r: any) => r.handle);
}

// ---------- rewards ----------
export function insertRewardSnapshot(db: DB, r: { handle: string; runId: number; view: string; rank: number | null; rewards: number | null; unit: string | null; raw: string }) {
  db.prepare(`INSERT INTO reward_snapshots (handle, run_id, scraped_at, view, rank, rewards, rewards_unit, raw) VALUES (?,?,?,?,?,?,?,?)`)
    .run(r.handle, r.runId, nowIso(), r.view, r.rank, r.rewards, r.unit, r.raw);
}

// ---------- profile snapshots ----------
export function insertProfileSnapshot(db: DB, p: { handle: string; runId: number; status: "ok" | "failed"; header?: HeaderTotals | null; rowsParsed?: number; source?: string; error?: string | null }) {
  db.prepare(`INSERT INTO profile_snapshots (handle, run_id, scraped_at, status, header_callouts, header_tailers, header_tail_volume, rows_parsed, source, error)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(p.handle, p.runId, nowIso(), p.status, p.header?.callouts ?? null, p.header?.tailers ?? null, p.header?.tailVolume ?? null, p.rowsParsed ?? null, p.source ?? "dom", p.error ?? null);
}

// ---------- callouts ----------
interface CalloutRow { id: number; handle: string; token: string; callout_date: string; callout_at: string; entry_mc: number | null; age_known: number }

const sameMc = (a: number | null, b: number | null) => {
  if (a === null || b === null) return true; // unknown on either side: don't rule it out
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom <= 0.02;
};

/**
 * Find the callout this parsed row refers to, or create it. Returns the callout id.
 * Match rule: same handle + token, callout date within +/- 1 day, compatible entry MC.
 */
export function matchOrCreateCallout(db: DB, handle: string, row: ParsedRow, scrapedAt: Date, runId: number | null): number {
  const at = calloutTime(scrapedAt, row.ageDays) ?? scrapedAt;
  const ageKnown = row.ageDays !== null ? 1 : 0;
  const date = at.toISOString().slice(0, 10);
  // The +/- 1 day rule only applies when both sides know the date: a stored callout
  // with age_known = 0 carries a placeholder date (its first sight), and a row whose
  // age failed to parse cannot be excluded by date either. Without this the
  // refinement below could never trigger for callouts older than a day.
  const candidates = db.prepare(`
    SELECT id, handle, token, callout_date, callout_at, entry_mc, age_known FROM callouts
    WHERE handle = ? AND token = ?
      AND (age_known = 0 OR ? = 0 OR abs(julianday(callout_date) - julianday(?)) <= 1.0)
  `).all(handle, row.name, ageKnown, date) as CalloutRow[];

  const compatible = candidates
    .filter((c) => sameMc(c.entry_mc, row.entryMc))
    .sort((a, b) => Math.abs(new Date(a.callout_at).getTime() - at.getTime()) - Math.abs(new Date(b.callout_at).getTime() - at.getTime()));

  if (compatible.length) {
    const c = compatible[0];
    if (c.entry_mc === null && row.entryMc !== null) db.prepare(`UPDATE callouts SET entry_mc = ? WHERE id = ?`).run(row.entryMc, c.id);
    // a more precise age (hours/minutes) seen later refines the stored time
    if (!c.age_known && ageKnown) db.prepare(`UPDATE callouts SET callout_at=?, callout_date=?, age_known=1, age_precision=? WHERE id=?`).run(at.toISOString(), date, ageDaysPrecision(row.ageRaw), c.id);
    return c.id;
  }

  const r = db.prepare(`
    INSERT INTO callouts (handle, token, callout_date, callout_at, age_precision, age_known, entry_mc, first_seen_at, first_run_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(handle, row.name, date, at.toISOString(), ageDaysPrecision(row.ageRaw), ageKnown, row.entryMc, scrapedAt.toISOString(), runId);
  return Number(r.lastInsertRowid);
}

export function insertCalloutSnapshot(db: DB, calloutId: number, runId: number, row: ParsedRow, scrapedAt: Date) {
  db.prepare(`
    INSERT INTO callout_snapshots (callout_id, run_id, scraped_at, age_days, age_raw, tailers, pnl_1h, pnl_1d, peak, multiplier, entry_mc, peak_mc, mc_raw, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(calloutId, runId, scrapedAt.toISOString(), row.ageDays, row.ageRaw, row.tailers, row.pnl1h, row.pnl1d, row.peak, row.mult, row.entryMc, row.peakMc, row.mc || null, row.raw);
}

/** Store a whole parsed profile (rows + header) for one run. */
export function storeProfileResult(db: DB, handle: string, runId: number, rows: ParsedRow[], header: HeaderTotals | null, source = "dom", scrapedAt: Date = new Date()) {
  const tx = db.transaction(() => {
    for (const row of rows) {
      const id = matchOrCreateCallout(db, handle, row, scrapedAt, runId);
      insertCalloutSnapshot(db, id, runId, row, scrapedAt);
    }
    insertProfileSnapshot(db, { handle, runId, status: "ok", header, rowsParsed: rows.length, source });
  });
  tx();
}
