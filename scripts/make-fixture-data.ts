/**
 * Build a synthetic dataset for developing the site without a real scrape.
 *
 *   npx tsx scripts/make-fixture-data.ts
 *
 * Creates a temporary SQLite DB with 3 fake KOLs (10-30 callouts each, negative
 * values, null peaks, missing multipliers, three runs of snapshots, reward
 * snapshots for the all / monthly views, one failed profile) and exports it with
 * the real exporter (src/export.ts) to site/public/data. meta.json gets a
 * top-level `fixture: true`.
 *
 * Safety: refuses to run when site/public/data/meta.json exists without
 * `fixture: true`, so real scraped data is never overwritten.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb, startRun, finishRun, upsertKol, insertRewardSnapshot, insertProfileSnapshot,
  matchOrCreateCallout, insertCalloutSnapshot,
} from "../src/db";
import { exportBundle } from "../src/export";
import { loadConfig, fromRoot, profileUrl } from "../src/config";
import type { ParsedRow } from "../src/parser";

const cfg = loadConfig();
const outDir = fromRoot(cfg.export.siteDataDir);
const metaPath = path.join(outDir, "meta.json");

if (fs.existsSync(metaPath)) {
  let existing: any = null;
  try { existing = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { /* unreadable: treat as real */ }
  if (existing?.fixture !== true) {
    console.error(`Refusing to overwrite ${metaPath}: it is not fixture data (no "fixture": true). Delete it manually if you really want fixtures.`);
    process.exit(1);
  }
}

// ---------- deterministic PRNG so fixtures are stable ----------
let seed = 0xc0ffee;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (a: number, b: number) => a + rand() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const fmt = (v: number | null): string => {
  if (v === null) return "—";
  const abs = Math.abs(v);
  const body = abs >= 1e6 ? `$${(abs / 1e6).toFixed(2)}M` : abs >= 1e3 ? `$${(abs / 1e3).toFixed(1)}K` : `$${abs.toFixed(0)}`;
  return (v < 0 ? "-" : "+") + body;
};
const fmtMc = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(1)}K`);

const TOKENS = ["PEPE2", "WIF JR", "MOONCAT", "GIGACHAD", "BONKED", "RUGPULL", "SOLANA DOGE", "TRUMPCOIN", "PNUT", "GOAT", "FARTCOIN", "CHILLGUY", "MICHI", "POPCAT", "RETARDIO", "HAWK", "MOODENG", "LUCE", "ACT", "PNUTS", "ZEREBRO", "AI16Z", "GRIFFAIN", "BUZZ", "ARC", "ALCH", "SWARMS", "TRUMP", "MELANIA", "VINE"];

interface FixtureCallout {
  token: string;
  calloutAt: Date;
  tailers: number;
  pnl1h: number | null;
  pnl1d: number | null;
  peak: number | null;
  mult: number | null;
  entryMc: number | null;
  peakMc: number | null;
}

const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400e3);
const RUN_TIMES = [daysAgo(2.02), daysAgo(1.01), daysAgo(0.01)]; // three daily runs

function makeCallouts(n: number): FixtureCallout[] {
  const out: FixtureCallout[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    let token = pick(TOKENS);
    while (used.has(token)) token = pick(TOKENS) + " " + Math.floor(rand() * 90 + 10);
    used.add(token);
    // ages spread from a few hours to ~70 days so every window differs
    const ageDays = rand() < 0.3 ? between(0.05, 6) : rand() < 0.6 ? between(7, 30) : between(31, 70);
    const tailers = Math.round(between(3, 900));
    const entryMc = rand() < 0.1 ? null : Math.round(between(5e3, 250e3));
    const hasPeak = rand() > 0.15;
    const mult = !hasPeak || rand() < 0.2 ? null : Math.round(between(1.1, 80) * 10) / 10;
    const pnl1h = rand() < 0.05 ? null : Math.round(between(-25e3, 60e3));
    const pnl1d = rand() < 0.05 ? null : Math.round(between(-40e3, 200e3));
    const peak = hasPeak ? Math.round(Math.max(pnl1d ?? 0, pnl1h ?? 0, 0) + between(0, 300e3)) : null;
    const peakMc = entryMc !== null && mult !== null ? Math.round(entryMc * mult) : null;
    out.push({ token, calloutAt: daysAgo(ageDays), tailers, pnl1h, pnl1d, peak, mult, entryMc, peakMc });
  }
  return out.sort((a, b) => b.calloutAt.getTime() - a.calloutAt.getTime());
}

/** What pump.fun would render for this callout at a given scrape time, run index drifting values upward. */
function rowAt(c: FixtureCallout, scrapedAt: Date, runIdx: number): ParsedRow | null {
  if (c.calloutAt.getTime() > scrapedAt.getTime()) return null; // did not exist yet
  const ageDays = (scrapedAt.getTime() - c.calloutAt.getTime()) / 86400e3;
  const ageRaw = ageDays < 1 ? `${Math.max(1, Math.round(ageDays * 24))}h ago` : ageDays < 14 ? `${Math.round(ageDays)}d ago` : `${Math.round(ageDays / 7)}w ago`;
  const growth = 1 + runIdx * between(0, 0.25);
  const tailers = c.tailers + Math.round(runIdx * between(0, 15));
  const peak = c.peak === null ? null : Math.round(c.peak * growth);
  const pnl1d = c.pnl1d === null ? null : runIdx === 0 && ageDays < 1 ? null : c.pnl1d; // 1d not yet known on a fresh callout
  const mc = c.entryMc !== null && c.peakMc !== null ? `${fmtMc(c.entryMc)} → ${fmtMc(Math.round(c.peakMc * growth))} MC` : "";
  const raw = `${tailers} tailers · 1h ${fmt(c.pnl1h)} · 1d ${fmt(pnl1d)} · reached ${fmt(peak)}`;
  return {
    name: c.token, ageDays, ageRaw, tailers, pnl1h: c.pnl1h, pnl1d, peak, mult: c.mult, mc,
    entryMc: c.entryMc, peakMc: c.peakMc === null ? null : Math.round(c.peakMc * growth),
    key: `${c.token}|${ageDays}|${c.mult}|${tailers}`, raw,
  };
}

const KOLS = [
  { handle: "mickeymantled", displayName: "Mickey Mantled", avatar: true, source: "leaderboard", n: 28, rewards: { all: 48_200, monthly: 12_900 }, unit: "USD", failsLastRun: false },
  { handle: "Degen_Dave99", displayName: "degen dave", avatar: false, source: "leaderboard", n: 17, rewards: { all: 310.5, monthly: null }, unit: "SOL", failsLastRun: false },
  { handle: "rug.hunter ü", displayName: null, avatar: true, source: "config", n: 11, rewards: null, unit: null, failsLastRun: true },
];

const svgAvatar = (letter: string, bg: string) =>
  `data:image/svg+xml;utf8,` + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${bg}"/><text x="32" y="41" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#0b0d12">${letter}</text></svg>`);

// ---------- build the temp DB ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "callout-fixture-"));
const dbFile = path.join(tmpDir, "fixture.sqlite");
const db = openDb(dbFile);

try {
  const callouts = new Map<string, FixtureCallout[]>();
  for (const k of KOLS) {
    upsertKol(db, { handle: k.handle, displayName: k.displayName, avatarUrl: k.avatar ? svgAvatar(k.handle[0].toUpperCase(), k.handle === "mickeymantled" ? "#34d399" : "#fbbf24") : null, profileUrl: profileUrl(k.handle), source: k.source });
    callouts.set(k.handle, makeCallouts(k.n));
  }

  RUN_TIMES.forEach((runAt, runIdx) => {
    const runId = startRun(db, `fixture run ${runIdx + 1}`);
    let ok = 0, failed = 0;
    for (const k of KOLS) {
      // leaderboard rewards (views all + monthly), only for KOLs on the leaderboard
      if (k.rewards) {
        for (const view of ["all", "monthly"] as const) {
          const v = k.rewards[view];
          if (v === null) continue;
          const value = Math.round(v * (1 + runIdx * 0.03) * 100) / 100;
          insertRewardSnapshot(db, { handle: k.handle, runId, view, rank: view === "all" ? KOLS.indexOf(k) + 1 : KOLS.indexOf(k) + 3, rewards: value, unit: k.unit, raw: `${k.handle} ${value} ${k.unit}` });
        }
      }
      const isLast = runIdx === RUN_TIMES.length - 1;
      if (k.failsLastRun && isLast) {
        insertProfileSnapshot(db, { handle: k.handle, runId, status: "failed", error: "Callouts modal did not render after 3 attempts (timeout 30s)" });
        failed++;
        continue;
      }
      const rows = callouts.get(k.handle)!.map((c) => rowAt(c, runAt, runIdx)).filter((r): r is ParsedRow => r !== null);
      // an "age unknown" row only visible in the last run (pump.fun showed no age label)
      if (isLast && k.handle === "Degen_Dave99") rows.push({ name: "NOAGE", ageDays: null, ageRaw: null, tailers: 42, pnl1h: -1200, pnl1d: 3400, peak: null, mult: null, mc: "", entryMc: 12_000, peakMc: null, key: "NOAGE|null|null|42", raw: "42 tailers · 1h -$1.2K · 1d +$3.4K · reached —" });
      const tx = db.transaction(() => {
        for (const row of rows) {
          const id = matchOrCreateCallout(db, k.handle, row, runAt, runId);
          insertCalloutSnapshot(db, id, runId, row, runAt);
        }
        const header = { callouts: rows.length, tailers: rows.reduce((a, r) => a + r.tailers, 0), tailVolume: Math.round(rows.reduce((a, r) => a + r.tailers, 0) * between(80, 400)) };
        insertProfileSnapshot(db, { handle: k.handle, runId, status: "ok", header, rowsParsed: rows.length, source: "dom" });
      });
      tx();
      ok++;
    }
    finishRun(db, runId, { status: failed ? "partial" : "ok", total: KOLS.length, ok, failed });
    // make run / profile / reward timestamps match the simulated scrape time
    const iso = runAt.toISOString();
    const started = new Date(runAt.getTime() - 9 * 60e3).toISOString();
    db.prepare(`UPDATE runs SET started_at=?, finished_at=? WHERE id=?`).run(started, iso, runId);
    db.prepare(`UPDATE profile_snapshots SET scraped_at=? WHERE run_id=?`).run(iso, runId);
    db.prepare(`UPDATE reward_snapshots SET scraped_at=? WHERE run_id=?`).run(iso, runId);
  });

  const r = exportBundle(db, cfg, { now: NOW });

  // mark the bundle as synthetic
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.fixture = true;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`fixture: ${r.kols} KOLs / ${r.callouts} callouts exported to ${r.outDir} (meta.fixture = true)`);
} finally {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
