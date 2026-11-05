import { loadConfig } from "../config";

// npm run scrape:request -- [--handle a,b] [--skip-leaderboard] [--limit N] [--debug] [--url http://127.0.0.1:47831]
//
// Asks the running collector (npm run collector) to start a run at the client's
// next poll: POST /request-run, then prints GET /status. Exits 1 when the collector
// is not reachable.
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const cfg = loadConfig();
const base = (val("url") ?? process.env.COLLECTOR_URL ?? `http://127.0.0.1:${cfg.collectorPort ?? 47831}`).replace(/\/+$/, "");

const handlesArg = val("handle") ?? val("handles");
const body: Record<string, unknown> = {};
if (handlesArg) body.handles = handlesArg.split(",").map((s) => s.trim()).filter(Boolean);
if (flag("skip-leaderboard")) body.skipLeaderboard = true;
if (val("limit")) {
  const n = parseInt(val("limit")!, 10);
  if (!Number.isInteger(n) || n < 0) { console.error(`bad --limit value: ${val("limit")}`); process.exit(2); }
  if (n > 0) body.limit = n;
}
if (flag("debug")) body.debug = true;

async function call(method: string, p: string, payload?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${json?.error ?? text.slice(0, 200)}`);
  return json;
}

(async () => {
  try {
    await call("POST", "/request-run", body);
    const status = await call("GET", "/status");
    console.log(`requested a run at ${base}${Object.keys(body).length ? " with " + JSON.stringify(body) : ""}`);
    console.log(JSON.stringify(status, null, 2));
    if (status?.running) console.log(`note: run ${status.running.runId} is in progress; the request is queued until it finishes.`);
    else console.log("the request is picked up at the client's next /due poll (about a minute).");
  } catch (e: any) {
    const cause = e?.cause ?? e;
    const code = cause?.code ?? e?.name;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "TimeoutError" || code === "AbortError" || /fetch failed/i.test(String(e?.message))) {
      console.error(`collector not reachable at ${base} (${code ?? e?.message}).`);
      console.error(`start it with:  npm run collector     (or install the LaunchAgent: scripts/install-launchd.sh --only collector)`);
      process.exit(1);
    }
    console.error(`request failed: ${e?.message ?? String(e)}`);
    process.exit(1);
  }
})();
