import { loadConfig, ensureDirs, normalizeHandle, profileUrl } from "../config";
import { log } from "../log";
import { launchContext, ensureSession } from "../scraper/browser";
import { EndpointDiscovery } from "../scraper/discovery";
import { scrapeProfile } from "../scraper/profile";
import { openDb, startRun, finishRun, upsertKol, storeProfileResult } from "../db";
import { exportBundle } from "../export";

// npm run verify <handle> [--save] [--debug] [--no-interactive]
const args = process.argv.slice(2);
const handle = normalizeHandle(args.find((a) => !a.startsWith("--")) ?? "");
if (!handle) {
  console.error("usage: npm run verify <handle> [--save] [--debug]");
  process.exit(1);
}
const save = args.includes("--save");
const debug = args.includes("--debug");
const interactive = !args.includes("--no-interactive") && !!process.stdin.isTTY;

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`);

(async () => {
  const cfg = loadConfig();
  ensureDirs();
  const ctx = await launchContext(cfg);
  const discovery = new EndpointDiscovery();
  discovery.attach(ctx);
  discovery.currentHandle = handle;
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let code = 0;
  try {
    await ensureSession(page, cfg, interactive);
    const t0 = Date.now();
    const res = await scrapeProfile(page, handle, { debug, interactive });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    console.log("");
    console.log(`profile:      ${res.url}`);
    console.log(`display name: ${res.displayName ?? "?"}`);
    console.log(`avatar:       ${res.avatarUrl ?? "?"}`);
    console.log(`header:       Callouts ${res.header.callouts ?? "?"} · Tailers ${res.header.tailers ?? "?"} · Tail volume ${res.header.tailVolume !== null ? "$" + fmt(res.header.tailVolume) : "?"}`);
    console.log(`rows parsed:  ${res.rows.length} in ${res.iterations} scroll steps (${secs}s)`);
    console.log("");
    console.table(res.rows.map((r) => ({
      token: r.name,
      age: r.ageRaw ?? "?",
      ageDays: r.ageDays === null ? null : +r.ageDays.toFixed(2),
      tailers: r.tailers,
      pnl1h: fmt(r.pnl1h),
      pnl1d: fmt(r.pnl1d),
      peak: fmt(r.peak),
      mult: r.mult === null ? "—" : `${r.mult}x`,
      mc: r.mc,
    })));
    const sum = (f: (r: typeof res.rows[number]) => number | null) => res.rows.reduce((a, r) => a + (f(r) || 0), 0);
    const withPeak = res.rows.filter((r) => r.peak !== null).map((r) => r.peak as number).sort((a, b) => a - b);
    console.log({
      handle,
      callouts_parsed: res.rows.length,
      callouts_with_peak: withPeak.length,
      tailers_total: sum((r) => r.tailers),
      pnl_1h_total: sum((r) => r.pnl1h),
      pnl_1d_total: sum((r) => r.pnl1d),
      peak_total: sum((r) => r.peak),
      peak_median: withPeak.length ? withPeak[Math.floor(withPeak.length / 2)] : null,
    });
    console.log(`raw modal text saved to data/raw/${handle}.txt`);

    if (save) {
      const db = openDb();
      const runId = startRun(db, `verify ${handle}`);
      upsertKol(db, { handle, displayName: res.displayName, avatarUrl: res.avatarUrl, profileUrl: profileUrl(handle), source: "config" });
      storeProfileResult(db, handle, runId, res.rows, res.header);
      finishRun(db, runId, { status: "ok", total: 1, ok: 1, failed: 0 });
      const r = exportBundle(db, cfg);
      db.close();
      console.log(`saved to SQLite (run ${runId}) and exported ${r.kols} KOLs to ${r.outDir}`);
    }
  } catch (e) {
    log.error("verify failed:", String(e));
    code = 1;
  } finally {
    const eps = await discovery.save().catch(() => []);
    if (eps.length) {
      console.log("\nJSON endpoints seen that mention tailers/callouts (shapes in data/discovered_endpoints.json):");
      for (const e of eps) console.log(`  ${e.method} ${e.url}  hits=${e.hits}${e.looksLikeCallouts ? "  <- looks like a callouts list" : ""}`);
    } else {
      console.log("\nno JSON endpoints mentioning tailers/callouts were observed");
    }
    await ctx.close().catch(() => {});
    process.exit(code);
  }
})();
