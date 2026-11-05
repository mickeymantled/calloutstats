import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { fromRoot, profileUrl, type Config, type WindowDef, ENDPOINTS_PATH } from "./config";

export interface WindowAgg {
  callouts: number;
  calloutsWithPeak: number;
  tailers: number;
  pnl1h: number;
  pnl1d: number;
  peak: number;
  peakMedian: number | null;
  rewards: number | null;
  rewardsUnit: string | null;
  rewardsToPeak: number | null;
}

export interface CompactCallout { at: number; tailers: number; pnl1h: number | null; pnl1d: number | null; peak: number | null }

/** Which leaderboard view best matches a window. */
export function rewardsViewForWindow(w: WindowDef): string {
  if (w.days === 1) return "daily";
  if (w.days === 7) return "weekly";
  if (w.days === 30) return "monthly";
  return "all";
}

export function windowStart(w: WindowDef, now: Date): number | null {
  if (w.days) return now.getTime() - w.days * 86400e3;
  if (w.since) return Date.parse(w.since + "T00:00:00Z");
  return null;
}

/** Aggregate compact callouts for a window. Same logic ships in the site (site/lib/aggregate.ts). */
export function aggregate(rows: CompactCallout[], start: number | null, rewards: { value: number | null; unit: string | null }): WindowAgg {
  const inWin = start === null ? rows : rows.filter((r) => r.at >= start);
  const withPeak = inWin.filter((r) => r.peak !== null);
  const sum = (f: (r: CompactCallout) => number | null) => inWin.reduce((a, r) => a + (f(r) || 0), 0);
  const peaks = withPeak.map((r) => r.peak as number).sort((a, b) => a - b);
  const peak = sum((r) => r.peak);
  return {
    callouts: inWin.length,
    calloutsWithPeak: withPeak.length,
    tailers: sum((r) => r.tailers),
    pnl1h: sum((r) => r.pnl1h),
    pnl1d: sum((r) => r.pnl1d),
    peak,
    peakMedian: peaks.length ? peaks[Math.floor(peaks.length / 2)] : null,
    rewards: rewards.value,
    rewardsUnit: rewards.unit,
    rewardsToPeak: rewards.value !== null && peak > 0 ? rewards.value / peak : null,
  };
}

interface LatestSnap {
  callout_id: number; token: string; callout_at: string; callout_date: string; age_precision: string | null; age_known: number; first_seen_at: string;
  scraped_at: string; age_raw: string | null; tailers: number; pnl_1h: number | null; pnl_1d: number | null; peak: number | null;
  multiplier: number | null; entry_mc: number | null; peak_mc: number | null; mc_raw: string | null;
}

function latestSnapshots(db: DB, handle: string): LatestSnap[] {
  return db.prepare(`
    SELECT c.id AS callout_id, c.token, c.callout_at, c.callout_date, c.age_precision, c.age_known, c.first_seen_at,
           s.scraped_at, s.age_raw, s.tailers, s.pnl_1h, s.pnl_1d, s.peak, s.multiplier, s.entry_mc, s.peak_mc, s.mc_raw
    FROM callouts c
    JOIN callout_snapshots s ON s.callout_id = c.id
    WHERE c.handle = ?
      AND s.id = (SELECT id FROM callout_snapshots WHERE callout_id = c.id ORDER BY scraped_at DESC, id DESC LIMIT 1)
    ORDER BY c.callout_at DESC
  `).all(handle) as LatestSnap[];
}

function latestRewards(db: DB, handle: string) {
  const rows = db.prepare(`
    SELECT view, rank, rewards, rewards_unit, scraped_at FROM reward_snapshots r
    WHERE handle = ? AND id = (SELECT id FROM reward_snapshots WHERE handle = r.handle AND view = r.view ORDER BY scraped_at DESC, id DESC LIMIT 1)
  `).all(handle) as { view: string; rank: number | null; rewards: number | null; rewards_unit: string | null; scraped_at: string }[];
  const out: Record<string, { value: number | null; rank: number | null; unit: string | null; at: string }> = {};
  for (const r of rows) out[r.view] = { value: r.rewards, rank: r.rank, unit: r.rewards_unit, at: r.scraped_at };
  return out;
}

function latestProfile(db: DB, handle: string) {
  return db.prepare(`SELECT * FROM profile_snapshots WHERE handle = ? ORDER BY scraped_at DESC, id DESC LIMIT 1`).get(handle) as any | undefined;
}
function latestOkProfile(db: DB, handle: string) {
  return db.prepare(`SELECT * FROM profile_snapshots WHERE handle = ? AND status='ok' ORDER BY scraped_at DESC, id DESC LIMIT 1`).get(handle) as any | undefined;
}

function history(db: DB, handle: string) {
  return db.prepare(`
    SELECT s.run_id AS runId, MAX(s.scraped_at) AS at, COUNT(*) AS callouts,
           SUM(COALESCE(s.peak,0)) AS peakSum, SUM(COALESCE(s.pnl_1d,0)) AS pnl1dSum, SUM(COALESCE(s.pnl_1h,0)) AS pnl1hSum, SUM(COALESCE(s.tailers,0)) AS tailers
    FROM callout_snapshots s JOIN callouts c ON c.id = s.callout_id
    WHERE c.handle = ?
    GROUP BY s.run_id ORDER BY at ASC
  `).all(handle) as { runId: number; at: string; callouts: number; peakSum: number; pnl1dSum: number; pnl1hSum: number; tailers: number }[];
}

export function exportBundle(db: DB, cfg: Config, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const outDir = fromRoot(cfg.export.siteDataDir);
  fs.mkdirSync(path.join(outDir, "kol"), { recursive: true });

  const kols = db.prepare(`SELECT * FROM kols ORDER BY handle`).all() as any[];
  const run = db.prepare(`SELECT * FROM runs WHERE status != 'running' ORDER BY id DESC LIMIT 1`).get() as any | undefined;

  const kolsOut: any[] = [];
  const compact: Record<string, number[][]> = {};
  const noCallouts: string[] = [];
  const failed: { handle: string; error: string | null; at: string }[] = [];
  let calloutCount = 0;

  for (const k of kols) {
    const snaps = latestSnapshots(db, k.handle);
    const rewards = latestRewards(db, k.handle);
    const prof = latestProfile(db, k.handle);
    const okProf = latestOkProfile(db, k.handle);
    const rows: CompactCallout[] = snaps.map((s) => ({ at: Date.parse(s.callout_at), tailers: s.tailers ?? 0, pnl1h: s.pnl_1h, pnl1d: s.pnl_1d, peak: s.peak }));
    calloutCount += rows.length;
    compact[k.handle] = rows.map((r) => [Math.round(r.at / 1000), r.tailers, r.pnl1h, r.pnl1d, r.peak] as number[]);
    if (prof?.status === "failed") failed.push({ handle: k.handle, error: prof.error, at: prof.scraped_at });
    if (okProf && rows.length === 0) noCallouts.push(k.handle);

    const windows: Record<string, WindowAgg> = {};
    for (const w of cfg.windows) {
      const rv = rewards[rewardsViewForWindow(w)] ?? rewards["all"];
      windows[w.id] = aggregate(rows, windowStart(w, now), { value: rv?.value ?? null, unit: rv?.unit ?? null });
    }

    const base = {
      handle: k.handle,
      displayName: k.display_name,
      avatarUrl: k.avatar_url,
      profileUrl: k.profile_url || profileUrl(k.handle),
      source: k.source,
      header: okProf ? { callouts: okProf.header_callouts, tailers: okProf.header_tailers, tailVolume: okProf.header_tail_volume, at: okProf.scraped_at } : null,
      rewards,
      lastScrapedAt: prof?.scraped_at ?? null,
      lastStatus: prof?.status ?? null,
      lastError: prof?.status === "failed" ? prof.error : null,
    };
    kolsOut.push({ ...base, windows });

    const detail = {
      ...base,
      generatedAt: now.toISOString(),
      windows,
      callouts: snaps.map((s) => ({
        id: s.callout_id,
        token: s.token,
        calloutAt: s.callout_at,
        calloutDate: s.callout_date,
        agePrecision: s.age_precision,
        ageKnown: !!s.age_known,
        ageRaw: s.age_raw,
        firstSeenAt: s.first_seen_at,
        scrapedAt: s.scraped_at,
        tailers: s.tailers,
        pnl1h: s.pnl_1h,
        pnl1d: s.pnl_1d,
        peak: s.peak,
        mult: s.multiplier,
        entryMc: s.entry_mc,
        peakMc: s.peak_mc,
        mcRaw: s.mc_raw,
        snapshots: (db.prepare(`SELECT scraped_at, tailers, pnl_1h, pnl_1d, peak FROM callout_snapshots WHERE callout_id = ? ORDER BY scraped_at`).all(s.callout_id) as any[])
          .map((x) => ({ at: x.scraped_at, tailers: x.tailers, pnl1h: x.pnl_1h, pnl1d: x.pnl_1d, peak: x.peak })),
      })),
      history: history(db, k.handle),
    };
    fs.writeFileSync(path.join(outDir, "kol", `${encodeURIComponent(k.handle)}.json`), JSON.stringify(detail));
  }

  const meta = {
    generatedAt: now.toISOString(),
    run: run ? { id: run.id, startedAt: run.started_at, finishedAt: run.finished_at, status: run.status, profilesTotal: run.profiles_total, profilesOk: run.profiles_ok, profilesFailed: run.profiles_failed, notes: run.notes } : null,
    windows: cfg.windows,
    defaultWindow: cfg.defaultWindow,
    kolCount: kolsOut.length,
    calloutCount,
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(outDir, "kols.json"), JSON.stringify(kolsOut));
  fs.writeFileSync(path.join(outDir, "callouts.json"), JSON.stringify({ generatedAt: now.toISOString(), columns: ["calloutAtEpochSec", "tailers", "pnl1h", "pnl1d", "peak"], byHandle: compact }));

  let endpoints: any[] = [];
  try { endpoints = JSON.parse(fs.readFileSync(ENDPOINTS_PATH, "utf8")).endpoints ?? []; } catch { /* none yet */ }
  const stale = kolsOut.filter((k) => k.lastScrapedAt && now.getTime() - Date.parse(k.lastScrapedAt) > 2 * 86400e3).map((k) => ({ handle: k.handle, lastScrapedAt: k.lastScrapedAt }));
  const gaps = {
    generatedAt: now.toISOString(),
    failedProfiles: failed,
    noCallouts,
    staleProfiles: stale,
    discoveredEndpoints: endpoints.map((e: any) => ({ url: e.url, hits: e.hits, keys: e.shape ? Object.keys(e.shape).slice(0, 20) : [] })),
  };
  fs.writeFileSync(path.join(outDir, "gaps.json"), JSON.stringify(gaps, null, 2));

  // prune detail files for handles no longer in the DB
  const keep = new Set(kolsOut.map((k) => `${encodeURIComponent(k.handle)}.json`));
  for (const f of fs.readdirSync(path.join(outDir, "kol"))) if (!keep.has(f)) fs.unlinkSync(path.join(outDir, "kol", f));

  return { kols: kolsOut.length, callouts: calloutCount, outDir };
}
