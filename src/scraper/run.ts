import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { loadConfig, ensureDirs, profileUrl, normalizeHandle, RUNS_DIR } from "../config";
import { log, sleep, randBetween } from "../log";
import { openDb, startRun, finishRun, upsertKol, insertRewardSnapshot, insertProfileSnapshot, storeProfileResult, allHandles } from "../db";
import { exportBundle } from "../export";
import { launchContext, ensureSession, HumanNeededError } from "./browser";
import { EndpointDiscovery } from "./discovery";
import { scrapeProfile, ProfileNotFoundError } from "./profile";
import { scrapeLeaderboard } from "./leaderboard";

export interface RunOptions {
  /** only these handles (skips the leaderboard) */
  handles?: string[];
  skipLeaderboard?: boolean;
  interactive?: boolean;
  limit?: number;
  debug?: boolean;
  skipExport?: boolean;
}

export interface RunSummary {
  runId: number;
  status: string;
  total: number;
  ok: number;
  failed: number;
  failures: { handle: string; error: string }[];
  startedAt: string;
  finishedAt: string;
  leaderboardHandles: number;
  endpoints: number;
}

export async function runScrape(opts: RunOptions = {}): Promise<RunSummary> {
  const cfg = loadConfig();
  ensureDirs();
  const db = openDb();
  const runId = startRun(db, opts.handles ? `handles: ${opts.handles.join(",")}` : undefined);
  const startedAt = new Date().toISOString();
  log.info(`run ${runId} started`);

  let ctx: BrowserContext | null = null;
  const discovery = new EndpointDiscovery();
  const failures: { handle: string; error: string }[] = [];
  let ok = 0, total = 0, leaderboardHandles = 0;
  let aborted = false;
  let fatal: string | null = null;

  const onSigint = () => { aborted = true; log.warn("interrupt received; finishing current profile then stopping"); };
  process.once("SIGINT", onSigint);

  try {
    ctx = await launchContext(cfg);
    discovery.attach(ctx);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await ensureSession(page, cfg, !!opts.interactive);

    // ---- Step A: leaderboard ----
    const ranked: string[] = [];
    if (!opts.skipLeaderboard && !opts.handles) {
      try {
        const entries = await scrapeLeaderboard(page, cfg.leaderboardViews, { interactive: opts.interactive });
        for (const e of entries) {
          upsertKol(db, { handle: e.handle, displayName: e.displayName, avatarUrl: e.avatarUrl, profileUrl: profileUrl(e.handle), source: "leaderboard" });
          insertRewardSnapshot(db, { handle: e.handle, runId, view: e.view, rank: e.rank, rewards: e.rewards, unit: e.unit, raw: e.raw });
          if (!ranked.includes(e.handle)) ranked.push(e.handle);
        }
        leaderboardHandles = ranked.length;
      } catch (e) {
        if (e instanceof HumanNeededError) throw e;
        log.error("leaderboard scrape failed; continuing with known handles", String(e));
      }
    }

    // ---- handle list ----
    const exclude = new Set(cfg.excludeHandles);
    let handles: string[];
    if (opts.handles) {
      handles = opts.handles.map(normalizeHandle);
    } else {
      for (const h of cfg.includeHandles) upsertKol(db, { handle: h, profileUrl: profileUrl(h), source: "config" });
      const known = allHandles(db);
      handles = [...ranked, ...cfg.includeHandles, ...known].filter((h, i, a) => a.indexOf(h) === i);
    }
    handles = handles.filter((h) => h && !exclude.has(h));
    const cap = opts.limit ?? cfg.maxProfilesPerRun;
    if (cap && handles.length > cap) handles = handles.slice(0, cap);
    total = handles.length;
    log.info(`scraping ${total} profiles`);

    // ---- Step B: profiles ----
    for (let i = 0; i < handles.length; i++) {
      if (aborted) break;
      const handle = handles[i];
      discovery.currentHandle = handle;
      let lastErr = "";
      let done = false;
      for (let attempt = 1; attempt <= cfg.maxRetriesPerProfile && !done; attempt++) {
        try {
          const res = await scrapeProfile(page, handle, { debug: opts.debug, interactive: opts.interactive });
          upsertKol(db, { handle, displayName: res.displayName, avatarUrl: res.avatarUrl, profileUrl: res.url, source: opts.handles ? "config" : "leaderboard" });
          storeProfileResult(db, handle, runId, res.rows, res.header);
          ok++;
          done = true;
          log.info(`[${i + 1}/${total}] ${handle}: ${res.rows.length} callouts (header: ${res.header.callouts ?? "?"} callouts, ${res.header.tailers ?? "?"} tailers, tail volume ${res.header.tailVolume ?? "?"}) in ${res.iterations} scroll steps`);
        } catch (e: any) {
          lastErr = e?.message ?? String(e);
          if (e instanceof ProfileNotFoundError) { log.warn(`[${i + 1}/${total}] ${handle}: ${lastErr}`); break; }
          if (e instanceof HumanNeededError) { log.error(lastErr); fatal = lastErr; aborted = true; break; }
          log.warn(`[${i + 1}/${total}] ${handle}: attempt ${attempt} failed: ${lastErr}`);
          if (attempt < cfg.maxRetriesPerProfile) await sleep(randBetween(1500, 3500));
        }
      }
      if (!done) {
        failures.push({ handle, error: lastErr });
        insertProfileSnapshot(db, { handle, runId, status: "failed", error: lastErr });
      }
      if (i < handles.length - 1 && !aborted) await sleep(randBetween(cfg.delayBetweenProfilesMs[0], cfg.delayBetweenProfilesMs[1]));
    }
  } catch (e) {
    fatal = String(e);
    log.error("run aborted:", fatal);
  } finally {
    process.off("SIGINT", onSigint);
  }

  const endpoints = await discovery.save().catch(() => [] as unknown[]);
  if (ctx) await ctx.close().catch(() => {});
  const status = fatal || aborted ? "failed" : failures.length ? "partial" : "ok";
  finishRun(db, runId, { status, total, ok, failed: failures.length, notes: fatal ?? undefined });
  const finishedAt = new Date().toISOString();
  const summary: RunSummary = { runId, status, total, ok, failed: failures.length, failures, startedAt, finishedAt, leaderboardHandles, endpoints: endpoints.length };
  fs.writeFileSync(path.join(RUNS_DIR, `${startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify({ ...summary, fatal }, null, 2));
  if (!opts.skipExport) {
    try {
      const r = exportBundle(db, cfg);
      log.info(`exported ${r.kols} KOLs / ${r.callouts} callouts to ${r.outDir}`);
    } catch (e) {
      log.error("export failed", String(e));
    }
  }
  log.info(`run ${runId} ${status}: ${ok}/${total} profiles ok, ${failures.length} failed, ${endpoints.length} JSON endpoints known`);
  db.close();
  return summary;
}
