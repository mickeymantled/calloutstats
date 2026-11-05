import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type DB } from "../db";
import { loadConfig, type Config } from "../config";
import { createCollector, computeDue, templateEndpointUrl, mergeEndpoints, dropCutDuplicates, parseReward, MAX_BODY_BYTES, type Collector } from "./server";
import { harvest, splitLines } from "../parser";

// ------------------------------------------------------------------ fixtures
// Three rows in the documented shape: a full row (51x), a `reached —` row with no
// multiplier, and a reached row that has an MC line but no multiplier.
const MODAL_TEXT = [
  "PUMP",
  "3d ago",
  "270 tailers · 1h +$2K · 1d +$9K · reached +$114K",
  "51x",
  "$39.3K → $2.01M MC",
  "DOGE",
  "5h ago",
  "12 tailers · 1h -$1.2K · 1d -$800 · reached —",
  "$10K → $12K MC",
  "CAT",
  "1d ago",
  "40 tailers · 1h +$100 · 1d +$500 · reached +$3K",
  "$5K → $20K MC",
].join("\n");

const HEADER_TEXT = ["Stats", "Callouts", "3", "Tailers", "322", "Tail volume", "$45K"].join("\n");
const DIALOG_TEXT = `${HEADER_TEXT}\nCallouts\n${MODAL_TEXT}`;

// 10-line blocks around the first and second rows, as a scrolling client would send
// them: they duplicate rows already in modalText and must dedupe to the same 3 rows.
const lines = MODAL_TEXT.split("\n");
const blockAround = (i: number) => lines.slice(Math.max(0, i - 6), i + 4).join("\n");
const BLOCKS = [blockAround(2), blockAround(7)];

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ------------------------------------------------------------------ harness
let tmp: string;
let db: DB;
let cfg: Config;
let collector: Collector;
let base: string;

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const count = (table: string, where = "1=1", ...args: unknown[]) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as any).n as number;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callout-collector-"));
  db = openDb(":memory:");
  cfg = {
    ...loadConfig(),
    includeHandles: ["configonly"],
    excludeHandles: ["banned"],
    maxRetriesPerProfile: 3,
    maxProfilesPerRun: 0,
    scrapeIntervalHours: 24,
    scheduleHourLocal: 6,
    leaderboardViews: ["all", "monthly"],
    delayBetweenProfilesMs: [2000, 4000],
    export: { siteDataDir: path.join(tmp, "site-data") },
  };
  collector = createCollector({ db, port: 0, cfg, dataDir: path.join(tmp, "data"), publish: false, logger: silent, version: "test" });
  base = (await collector.start()).url;
});

afterAll(async () => {
  await collector.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ pure functions
describe("computeDue", () => {
  const L = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi); // local time
  const base = { intervalHours: 24, scheduleHourLocal: 6, running: false, requested: false };

  it("is due when a run was requested, whatever the clock says", () => {
    expect(computeDue({ ...base, requested: true, now: L(2026, 11, 4, 2), lastStartedAt: L(2026, 11, 4, 1), lastFinishedAt: L(2026, 11, 4, 1, 30) }))
      .toEqual({ due: true, reason: "requested" });
  });
  it("is never due while a run is in progress", () => {
    expect(computeDue({ ...base, requested: true, running: true, now: L(2026, 11, 4, 9), lastStartedAt: null, lastFinishedAt: null })).toEqual({ due: false, reason: "" });
  });
  it("with no finished run yet: due once the local hour gate opens", () => {
    expect(computeDue({ ...base, now: L(2026, 11, 4, 5, 59), lastStartedAt: null, lastFinishedAt: null })).toEqual({ due: false, reason: "" });
    expect(computeDue({ ...base, now: L(2026, 11, 4, 6, 0), lastStartedAt: null, lastFinishedAt: null })).toEqual({ due: true, reason: "interval" });
  });
  it("interval + hour gate: not due before the hour, not due the same day, due the next day after the interval", () => {
    const lastStart = L(2026, 11, 3, 6, 1), lastEnd = L(2026, 11, 3, 6, 40);
    expect(computeDue({ ...base, now: L(2026, 11, 3, 9), lastStartedAt: lastStart, lastFinishedAt: lastEnd })).toEqual({ due: false, reason: "" }); // same day
    expect(computeDue({ ...base, now: L(2026, 11, 4, 5, 30), lastStartedAt: lastStart, lastFinishedAt: lastEnd })).toEqual({ due: false, reason: "" }); // before 06:00
    expect(computeDue({ ...base, now: L(2026, 11, 4, 6, 0), lastStartedAt: lastStart, lastFinishedAt: lastEnd })).toEqual({ due: false, reason: "" }); // 23h59m since start
    expect(computeDue({ ...base, now: L(2026, 11, 4, 6, 1), lastStartedAt: lastStart, lastFinishedAt: lastEnd })).toEqual({ due: true, reason: "interval" }); // 24h since start, run took 39 min: no creep
  });
  it("honours a shorter interval but still once per local day", () => {
    const i = { ...base, intervalHours: 12 };
    expect(computeDue({ ...i, now: L(2026, 11, 3, 20), lastStartedAt: L(2026, 11, 3, 6), lastFinishedAt: L(2026, 11, 3, 7) })).toEqual({ due: false, reason: "" });
    expect(computeDue({ ...i, now: L(2026, 11, 4, 6), lastStartedAt: L(2026, 11, 3, 6), lastFinishedAt: L(2026, 11, 3, 7) })).toEqual({ due: true, reason: "interval" });
  });
});

describe("templateEndpointUrl / mergeEndpoints", () => {
  it("redacts query values and templates the handle and long ids", () => {
    const t = templateEndpointUrl("https://frontend-api-v3.pump.fun/users/mickeymantled/callouts?limit=50&offset=100&limit=10", "mickeymantled")!;
    expect(t.url).toBe("https://frontend-api-v3.pump.fun/users/:handle/callouts?limit=<v>&offset=<v>");
    expect(t.host).toBe("frontend-api-v3.pump.fun");
    expect(templateEndpointUrl("https://x.pump.fun/coins/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU/trades", null)!.url).toBe("https://x.pump.fun/coins/:id/trades");
    expect(templateEndpointUrl("not a url", null)).toBeNull();
    expect(templateEndpointUrl("data:text/plain,abc", null)).toBeNull();
  });
  it("writes the discovery.ts file shape and counts hits per visit", () => {
    const file = path.join(tmp, "endpoints-unit.json");
    mergeEndpoints(file, ["https://a.pump.fun/p/h1?x=1", "https://a.pump.fun/p/h1?x=2"], "h1", new Date("2026-11-04T10:00:00Z"));
    mergeEndpoints(file, ["https://a.pump.fun/p/h2?x=3", "https://a.pump.fun/other"], "h2", new Date("2026-11-04T11:00:00Z"));
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(j.updatedAt).toBe("2026-11-04T11:00:00.000Z");
    expect(typeof j.note).toBe("string");
    expect(j.endpoints[0]).toEqual({ url: "https://a.pump.fun/p/:handle?x=<v>", method: "GET", hits: 2, firstSeen: "2026-11-04T10:00:00.000Z", lastSeen: "2026-11-04T11:00:00.000Z", matched: ["page"], looksLikeCallouts: false, shape: null, host: "a.pump.fun", path: "/p/:handle" });
    expect(j.endpoints.map((e: any) => e.url)).toContain("https://a.pump.fun/other");
  });
});

describe("parseReward", () => {
  it("accepts numeric rewards, or rewardsText in USD or SOL", () => {
    expect(parseReward({ rewards: 1234.5, rewardsText: null, unit: "USD" })).toEqual({ rewards: 1234.5, unit: "USD" });
    expect(parseReward({ rewards: null, rewardsText: "$1.2K", unit: "USD" })).toEqual({ rewards: 1200, unit: "USD" });
    expect(parseReward({ rewards: null, rewardsText: "12.5 SOL", unit: "SOL" })).toEqual({ rewards: 12.5, unit: "SOL" });
    expect(parseReward({ rewards: null, rewardsText: "+$2,340", unit: null })).toEqual({ rewards: 2340, unit: "USD" });
    expect(parseReward({ rewards: null, rewardsText: "3 sol", unit: null })).toEqual({ rewards: 3, unit: "SOL" });
    expect(parseReward({ rewards: null, rewardsText: "—", unit: null })).toEqual({ rewards: null, unit: null });
    expect(parseReward({ rewards: null, unit: null })).toEqual({ rewards: null, unit: null });
    expect(parseReward({ rewards: 7, rewardsText: "$1K", unit: "USD" })).toEqual({ rewards: 7, unit: "USD" }); // numeric wins
  });
});

describe("dropCutDuplicates", () => {
  it("removes the nameless twin a top-cut block produces, keeps genuinely nameless rows", () => {
    const rows = harvest(splitLines(MODAL_TEXT), new Map(), new Date());
    expect(rows.size).toBe(3);
    for (const b of BLOCKS) harvest(splitLines(b), rows, new Date());
    const all = [...rows.values()];
    expect(all.length).toBe(4); // the cut block re-reads PUMP as "?"
    expect(all.filter((r) => r.name === "?")).toHaveLength(1);
    const kept = dropCutDuplicates(all);
    expect(kept.map((r) => r.name).sort()).toEqual(["CAT", "DOGE", "PUMP"]);
    // a nameless row with no named twin survives
    const lone = harvest(["12 tailers · 1h +$1 · 1d +$2 · reached +$3"], new Map(), new Date());
    expect(dropCutDuplicates([...lone.values()]).map((r) => r.name)).toEqual(["?"]);
  });
});

// ------------------------------------------------------------------ HTTP: a whole run
describe("collector over HTTP", () => {
  let runId: number;

  it("answers OPTIONS preflights with CORS + private-network headers", async () => {
    const res = await fetch(`${base}/run/1/profile`, { method: "OPTIONS", headers: { origin: "https://pump.fun", "access-control-request-method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/OPTIONS/);
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("starts idle: /status and /due report nothing pending", async () => {
    const s = await api("GET", "/status");
    expect(s.status).toBe(200);
    expect(s.headers.get("access-control-allow-origin")).toBe("*");
    expect(s.json).toMatchObject({ ok: true, version: "test", running: null, lastRun: null, requested: null, kols: 0 });
    expect(typeof s.json.collectorHost).toBe("string");
    const d = await api("GET", "/due");
    expect(d.json.request).toBeNull();
    expect(d.json.reason === "requested").toBe(false);
  });

  it("rejects bad input: 404, 405, invalid JSON, oversized body", async () => {
    expect((await api("GET", "/nope")).status).toBe(404);
    expect((await api("GET", "/request-run")).status).toBe(405);
    const bad = await fetch(`${base}/request-run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
    const big = await fetch(`${base}/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x".repeat(MAX_BODY_BYTES + 1024) }) }).catch(() => null);
    if (big) expect(big.status).toBe(413); // the server may also drop the connection after destroying the request
    expect((await api("POST", "/run/999/profile", { handle: "x" })).status).toBe(404);
  });

  it("request-run makes /due true with the request", async () => {
    const r = await api("POST", "/request-run", { handles: ["@MickeyMantled", "https://pump.fun/profile/other", "ghost", "banned"], debug: true, limit: "0" });
    expect(r.json).toEqual({ ok: true });
    const d = await api("GET", "/due");
    expect(d.json.due).toBe(true);
    expect(d.json.reason).toBe("requested");
    expect(d.json.request.handles).toEqual(["MickeyMantled", "other", "ghost", "banned"]);
    expect(d.json.request.skipLeaderboard).toBe(true);
    expect(d.json.request.limit).toBeUndefined();
    expect(d.json.request.requestedAt).toMatch(/^\d{4}-/);
    const s = await api("GET", "/status");
    expect(s.json.due).toBe(true);
    expect(s.json.requested.handles).toHaveLength(4);
  });

  it("run/start returns the plan (explicit handles, leaderboard forced off, excludes applied) and clears the request", async () => {
    const d = await api("GET", "/due");
    const r = await api("POST", "/run/start", { source: "test-client", extensionVersion: "0.0.1", request: d.json.request });
    expect(r.status).toBe(200);
    runId = r.json.runId;
    expect(runId).toBeGreaterThan(0);
    expect(r.json).toMatchObject({ skipLeaderboard: true, leaderboardViews: ["all", "monthly"], delayMs: [2000, 4000], maxRetriesPerProfile: 3, debug: true });
    expect(r.json.handles).toEqual(["MickeyMantled", "other", "ghost"]);
    const s = await api("GET", "/status");
    expect(s.json.running).toMatchObject({ runId, handle: null });
    expect(s.json.requested).toBeNull();
    expect(s.json.due).toBe(false);
    expect((await api("GET", "/due")).json.due).toBe(false);
    expect(db.prepare(`SELECT status, notes FROM runs WHERE id = ?`).get(runId)).toEqual({ status: "running", notes: "test-client 0.0.1; handles: MickeyMantled,other,ghost,banned" }); // notes keep the request as made; the plan applies excludes
  });

  it("refuses a second concurrent run with 409", async () => {
    const r = await api("POST", "/run/start", { source: "test-client", extensionVersion: "0.0.1", request: null });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "run in progress", runId });
  });

  it("profile: parses modalText + blocks into one deduped row set and the header from dialogText", async () => {
    const r = await api("POST", `/run/${runId}/profile`, {
      handle: "MickeyMantled", url: "https://pump.fun/profile/MickeyMantled", attempt: 1, status: "ok",
      displayName: "Mickey", avatarUrl: "https://img/x.png",
      modalText: MODAL_TEXT, blocks: BLOCKS, dialogText: DIALOG_TEXT, state: "rows", iterations: 7, durationMs: 1234,
      endpoints: ["https://frontend-api-v3.pump.fun/users/MickeyMantled/callouts?limit=50&offset=0", "https://frontend-api-v3.pump.fun/users/MickeyMantled/stats", "chrome-extension://abc/x.js"],
      screenshotDataUrl: null,
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "ok", rows: 3, header: { callouts: 3, tailers: 322, tailVolume: 45000 }, zeroCallouts: false });

    // stored rows, incl. the reached — row (peak null) and the row without a multiplier
    const snaps = db.prepare(`SELECT c.token, s.tailers, s.pnl_1h, s.pnl_1d, s.peak, s.multiplier, s.entry_mc, s.peak_mc FROM callout_snapshots s JOIN callouts c ON c.id = s.callout_id WHERE s.run_id = ? ORDER BY c.token`).all(runId) as any[];
    expect(snaps).toEqual([
      { token: "CAT", tailers: 40, pnl_1h: 100, pnl_1d: 500, peak: 3000, multiplier: null, entry_mc: 5000, peak_mc: 20000 },
      { token: "DOGE", tailers: 12, pnl_1h: -1200, pnl_1d: -800, peak: null, multiplier: null, entry_mc: 10000, peak_mc: 12000 },
      { token: "PUMP", tailers: 270, pnl_1h: 2000, pnl_1d: 9000, peak: 114000, multiplier: 51, entry_mc: 39300, peak_mc: 2010000 },
    ]);
    const prof = db.prepare(`SELECT status, header_callouts, header_tailers, header_tail_volume, rows_parsed, source FROM profile_snapshots WHERE handle = 'MickeyMantled' AND run_id = ?`).get(runId);
    expect(prof).toEqual({ status: "ok", header_callouts: 3, header_tailers: 322, header_tail_volume: 45000, rows_parsed: 3, source: "dom" });
    const kol = db.prepare(`SELECT display_name, avatar_url, profile_url, source FROM kols WHERE handle = 'MickeyMantled'`).get();
    expect(kol).toEqual({ display_name: "Mickey", avatar_url: "https://img/x.png", profile_url: "https://pump.fun/profile/MickeyMantled", source: "config" });

    // raw text file: dialogText + separator + modalText
    const raw = fs.readFileSync(path.join(tmp, "data", "raw", "MickeyMantled.txt"), "utf8");
    expect(raw).toBe(`${DIALOG_TEXT}\n\n-----\n\n${MODAL_TEXT}`);

    // endpoints: redacted + templated, discovery.ts file shape, non-http dropped
    const ep = JSON.parse(fs.readFileSync(path.join(tmp, "data", "discovered_endpoints.json"), "utf8"));
    expect(Object.keys(ep).sort()).toEqual(["endpoints", "note", "updatedAt"]);
    const urls = ep.endpoints.map((e: any) => e.url).sort();
    expect(urls).toEqual(["https://frontend-api-v3.pump.fun/users/:handle/callouts?limit=<v>&offset=<v>", "https://frontend-api-v3.pump.fun/users/:handle/stats"]);
    expect(ep.endpoints[0]).toMatchObject({ method: "GET", hits: 1, matched: ["page"], looksLikeCallouts: false, shape: null, host: "frontend-api-v3.pump.fun" });
    expect(ep.endpoints[0].firstSeen).toBe(ep.endpoints[0].lastSeen);

    expect((await api("GET", "/status")).json.running.handle).toBe("MickeyMantled");
  });

  it("profile: empty modalText with state unknown -> retry, retry, then failed on attempt 3", async () => {
    const body = (attempt: number) => ({ handle: "other", url: "https://pump.fun/profile/other", attempt, status: "ok", modalText: "", blocks: [], dialogText: "Stats\nCallouts", state: "unknown" });
    expect((await api("POST", `/run/${runId}/profile`, body(1))).json).toEqual({ status: "retry", reason: "no rows parsed (state=unknown, header callouts=?)" });
    expect((await api("POST", `/run/${runId}/profile`, body(2))).json.status).toBe("retry");
    expect(count("profile_snapshots", "handle = 'other'")).toBe(0);
    const r3 = await api("POST", `/run/${runId}/profile`, body(3));
    expect(r3.json.status).toBe("failed");
    expect(r3.json.reason).toMatch(/no rows parsed/);
    expect(db.prepare(`SELECT status, error FROM profile_snapshots WHERE handle = 'other' AND run_id = ?`).all(runId)).toEqual([{ status: "failed", error: "no rows parsed (state=unknown, header callouts=?)" }]);
  });

  it("profile: a client-reported failure follows the same retry rule; notfound fails immediately", async () => {
    const f = await api("POST", `/run/${runId}/profile`, { handle: "other", attempt: 1, status: "failed", error: "timeout waiting for Stats" });
    expect(f.json).toEqual({ status: "retry", reason: "timeout waiting for Stats" });
    const nf = await api("POST", `/run/${runId}/profile`, { handle: "ghost", url: "https://pump.fun/profile/ghost", attempt: 1, status: "notfound", error: "profile not found" });
    expect(nf.json).toEqual({ status: "failed", reason: "profile not found" });
    expect(db.prepare(`SELECT status, error FROM profile_snapshots WHERE handle = 'ghost'`).all()).toEqual([{ status: "failed", error: "profile not found" }]);
    expect(count("kols", "handle = 'ghost'")).toBe(0);
  });

  it("profile: zero rows with state empty (or header callouts 0) is a successful empty profile", async () => {
    const r = await api("POST", `/run/${runId}/profile`, { handle: "quiet", attempt: 1, status: "ok", modalText: "No callouts in this period", blocks: [], dialogText: "Callouts\n0\nTailers\n0\nTail volume\n$0", state: "empty" });
    expect(r.json).toEqual({ status: "ok", rows: 0, header: { callouts: 0, tailers: 0, tailVolume: 0 }, zeroCallouts: true });
    expect(db.prepare(`SELECT status, rows_parsed FROM profile_snapshots WHERE handle = 'quiet'`).get()).toEqual({ status: "ok", rows_parsed: 0 });
  });

  it("log appends through the logger", async () => {
    const seen: string[] = [];
    const c2 = createCollector({ db: openDb(":memory:"), port: 0, cfg, dataDir: path.join(tmp, "data-log"), publish: false, logger: { ...silent, warn: (...a) => seen.push(a.join(" ")) } });
    const { url } = await c2.start();
    const r = await fetch(`${url}/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "warn", message: "hello from the client", runId: 7 }) });
    expect(await r.json()).toEqual({ ok: true });
    expect(seen).toEqual(["[ext] [run 7] hello from the client"]);
    await c2.stop();
  });

  it("finish: finishRun partial, run summary written, bundle exported, publish skipped", async () => {
    const r = await api("POST", `/run/${runId}/finish`, { total: 4, ok: 2, failed: 2, aborted: false, failures: [{ handle: "other", error: "no rows parsed" }, { handle: "ghost", error: "profile not found" }] });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.status).toBe("partial");
    expect(r.json.exported).toEqual({ kols: 2, callouts: 3 }); // MickeyMantled + quiet; includeHandles are only upserted when /handles is asked for
    const run = db.prepare(`SELECT status, profiles_total, profiles_ok, profiles_failed, finished_at FROM runs WHERE id = ?`).get(runId) as any;
    expect(run).toMatchObject({ status: "partial", profiles_total: 4, profiles_ok: 2, profiles_failed: 2 });
    expect(run.finished_at).toMatch(/^\d{4}-/);

    const runFiles = fs.readdirSync(path.join(tmp, "data", "runs"));
    expect(runFiles).toHaveLength(1);
    const summary = JSON.parse(fs.readFileSync(path.join(tmp, "data", "runs", runFiles[0]), "utf8"));
    expect(summary).toMatchObject({ runId, status: "partial", total: 4, ok: 2, failed: 2, leaderboardHandles: 0 });
    expect(summary.failures).toHaveLength(2);

    const site = path.join(tmp, "site-data");
    for (const f of ["meta.json", "kols.json", "callouts.json", "gaps.json", path.join("kol", "MickeyMantled.json")]) expect(fs.existsSync(path.join(site, f)), f).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(site, "meta.json"), "utf8"));
    expect(meta.run).toMatchObject({ id: runId, status: "partial", profilesOk: 2 });
    expect(meta.calloutCount).toBe(3);
    const gaps = JSON.parse(fs.readFileSync(path.join(site, "gaps.json"), "utf8"));
    expect(gaps.noCallouts).toEqual(["quiet"]);
    expect(fs.existsSync(path.join(tmp, "data", "logs", "publish.log"))).toBe(false);

    const s = await api("GET", "/status");
    expect(s.json.running).toBeNull();
    expect(s.json.lastRun).toMatchObject({ id: runId, status: "partial", profilesTotal: 4, profilesOk: 2, profilesFailed: 2 });
    expect(s.json.kols).toBe(2);
    expect((await api("POST", `/run/${runId}/profile`, { handle: "late", attempt: 1, status: "ok", modalText: "" })).status).toBe(404);
  });

  it("second run: leaderboard ingestion, handle plan ordering, excludes, finish ok", async () => {
    expect((await api("GET", "/due")).json.due).toBe(false); // finished today, so interval is not due
    await api("POST", "/request-run", {});
    const start = await api("POST", "/run/start", { source: "test-client", extensionVersion: "0.0.1", request: (await api("GET", "/due")).json.request });
    expect(start.json.skipLeaderboard).toBe(false);
    expect(start.json.handles).toEqual([]);
    const id = start.json.runId as number;

    const lb = await api("POST", `/run/${id}/leaderboard`, {
      view: "all",
      entries: [
        { handle: "alpha", displayName: "Alpha", avatarUrl: null, rank: 1, rewards: null, rewardsText: "$1,234.5", unit: "USD", raw: "1 Alpha $1.2K" },
        { handle: "MickeyMantled", displayName: null, avatarUrl: null, rank: 2, rewards: 900, unit: "USD", raw: "2 Mickey $900" },
        { handle: "banned", rank: 3, rewards: 1, unit: "USD", raw: "3" },
        { nope: true },
        { handle: "", rank: 5 },
      ],
      rawText: "Top rewards\n1 Alpha $1.2K\n2 Mickey $900",
    });
    expect(lb.json).toEqual({ ok: true, handles: 3 });
    expect(count("reward_snapshots", "run_id = ? AND view = 'all'", id)).toBe(3);
    expect(db.prepare(`SELECT rank, rewards, rewards_unit FROM reward_snapshots WHERE handle = 'alpha' AND run_id = ?`).get(id)).toEqual({ rank: 1, rewards: 1234.5, rewards_unit: "USD" });
    expect(fs.readFileSync(path.join(tmp, "data", "raw", "leaderboard-all.txt"), "utf8")).toMatch(/^Top rewards/);
    const lb2 = await api("POST", `/run/${id}/leaderboard`, { view: "monthly", entries: [{ handle: "beta", rank: 1, rewards: null, rewardsText: "5 SOL", unit: null, raw: "1 beta 5 SOL" }] });
    expect(lb2.json.handles).toBe(1);
    expect(db.prepare(`SELECT rewards, rewards_unit FROM reward_snapshots WHERE handle = 'beta' AND run_id = ?`).get(id)).toEqual({ rewards: 5, rewards_unit: "SOL" });

    // ranked first (minus excluded), then includeHandles, then every other known handle
    const plan = (await api("GET", `/run/${id}/handles`)).json.handles as string[];
    expect(plan.slice(0, 4)).toEqual(["alpha", "MickeyMantled", "beta", "configonly"]);
    expect(plan).not.toContain("banned");
    expect(plan).toContain("quiet");
    expect(new Set(plan).size).toBe(plan.length);
    expect(db.prepare(`SELECT source FROM kols WHERE handle = 'configonly'`).get()).toEqual({ source: "config" });

    const p = await api("POST", `/run/${id}/profile`, { handle: "alpha", attempt: 1, status: "ok", modalText: MODAL_TEXT, blocks: [], dialogText: DIALOG_TEXT, state: "rows" });
    expect(p.json.rows).toBe(3);
    expect(db.prepare(`SELECT source FROM kols WHERE handle = 'alpha'`).get()).toEqual({ source: "leaderboard" });

    const fin = await api("POST", `/run/${id}/finish`, { total: 1, ok: 1, failed: 0, aborted: false, failures: [] });
    expect(fin.json.status).toBe("ok");
    expect(fin.json.exported.callouts).toBe(6);
    const summaries = fs.readdirSync(path.join(tmp, "data", "runs"));
    expect(summaries).toHaveLength(2);
    const s = JSON.parse(fs.readFileSync(path.join(tmp, "data", "runs", summaries.sort()[1]), "utf8"));
    expect(s).toMatchObject({ runId: id, status: "ok", leaderboardHandles: 4, leaderboardViews: ["all", "monthly"] }); // alpha, MickeyMantled, banned (all) + beta (monthly)
  });

  it("limit caps the handle plan", async () => {
    await api("POST", "/request-run", { limit: 2, skipLeaderboard: true });
    const start = await api("POST", "/run/start", { source: "t", extensionVersion: "0", request: (await api("GET", "/due")).json.request });
    expect(start.json.skipLeaderboard).toBe(true);
    const plan = (await api("GET", `/run/${start.json.runId}/handles`)).json.handles as string[];
    expect(plan).toHaveLength(2);
    expect(plan[0]).toBe("configonly"); // no leaderboard this run: includeHandles come first
    const fin = await api("POST", `/run/${start.json.runId}/finish`, { total: 0, ok: 0, failed: 0, aborted: true, failures: [] });
    expect(fin.json.status).toBe("failed");
    expect(db.prepare(`SELECT notes FROM runs WHERE id = ?`).get(start.json.runId)).toEqual({ notes: "aborted" });
  });

  it("a stale running run (> 3 h) is marked failed/abandoned by the next run/start; a fresh one blocks it", async () => {
    const stale = db.prepare(`INSERT INTO runs (started_at, status) VALUES (?, 'running')`).run(new Date(Date.now() - 4 * 3600e3).toISOString());
    const staleId = Number(stale.lastInsertRowid);
    expect((await api("GET", "/status")).json.running).toBeNull(); // not adopted until something refers to it
    const start = await api("POST", "/run/start", { source: "t", extensionVersion: "0", request: null });
    expect(start.status).toBe(200);
    expect(db.prepare(`SELECT status, notes, finished_at FROM runs WHERE id = ?`).get(staleId)).toMatchObject({ status: "failed", notes: "abandoned" });
    expect((db.prepare(`SELECT finished_at FROM runs WHERE id = ?`).get(staleId) as any).finished_at).toBeTruthy();
    // a request made while the run is in progress is queued and visible on /status
    await api("POST", "/request-run", { handles: ["later"] });
    expect((await api("GET", "/due")).json.due).toBe(false);
    expect((await api("GET", "/status")).json.requested.handles).toEqual(["later"]);
    expect((await api("POST", "/run/start", { source: "t", extensionVersion: "0", request: null })).status).toBe(409);
    await api("POST", `/run/${start.json.runId}/finish`, { total: 0, ok: 0, failed: 0, aborted: false, failures: [] });
    const d = await api("GET", "/due");
    expect(d.json).toMatchObject({ due: true, reason: "requested" });
    expect(d.json.request.handles).toEqual(["later"]);
    // run/start with request: null still honours the pending request instead of dropping it
    const st = await api("POST", "/run/start", { source: "t", extensionVersion: "0", request: null });
    expect(st.json.handles).toEqual(["later"]);
    await api("POST", `/run/${st.json.runId}/finish`, { total: 0, ok: 0, failed: 0, aborted: false, failures: [] });
    expect((await api("GET", "/status")).json.requested).toBeNull();
  });

  it("recovers a running run from the database on startup", async () => {
    const db2 = openDb(":memory:");
    const id = Number(db2.prepare(`INSERT INTO runs (started_at, status) VALUES (?, 'running')`).run(new Date().toISOString()).lastInsertRowid);
    const c2 = createCollector({ db: db2, port: 0, cfg, dataDir: path.join(tmp, "data-recover"), publish: false, logger: silent });
    const { url } = await c2.start();
    expect(c2.state.running?.runId).toBe(id);
    const s = await (await fetch(`${url}/status`)).json();
    expect(s.running).toMatchObject({ runId: id });
    expect(s.due).toBe(false);
    const fin = await (await fetch(`${url}/run/${id}/finish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ total: 0, ok: 0, failed: 0, aborted: false, failures: [] }) })).json();
    expect(fin.status).toBe("ok");
    await c2.stop();
    db2.close();
  });
});

// ------------------------------------------------------------------ POST /capture (console script)
describe("POST /capture", () => {
  it("stores a manual capture as its own run with source import and the capture's scrapedAt", async () => {
    const before = count("runs");
    const r = await api("POST", "/capture", {
      version: 1, handle: "@CaptureGuy", url: "https://pump.fun/profile/CaptureGuy", scrapedAt: "2026-11-01T12:00:00.000Z",
      displayName: "Capture Guy", avatarUrl: "https://img/c.png", dialogText: DIALOG_TEXT, modalText: MODAL_TEXT, blocks: BLOCKS,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, rows: 3, header: { callouts: 3, tailers: 322, tailVolume: 45000 }, zeroCallouts: false });
    expect(r.json.exported.kols).toBeGreaterThan(0);
    expect(count("runs")).toBe(before + 1);
    const run = db.prepare(`SELECT status, notes, profiles_total, profiles_ok, finished_at FROM runs WHERE id = ?`).get(r.json.runId) as any;
    expect(run).toMatchObject({ status: "ok", notes: "capture: CaptureGuy", profiles_total: 1, profiles_ok: 1 });
    expect(run.finished_at).toBeTruthy();
    expect(db.prepare(`SELECT status, source, rows_parsed FROM profile_snapshots WHERE handle = 'CaptureGuy'`).get()).toEqual({ status: "ok", source: "import", rows_parsed: 3 });
    expect(db.prepare(`SELECT source, display_name FROM kols WHERE handle = 'CaptureGuy'`).get()).toEqual({ source: "config", display_name: "Capture Guy" });
    // callout times are anchored to the capture's scrapedAt (PUMP was "3d ago")
    const pump = db.prepare(`SELECT callout_at FROM callouts WHERE handle = 'CaptureGuy' AND token = 'PUMP'`).get() as any;
    expect(pump.callout_at).toBe("2026-10-29T12:00:00.000Z");
    expect(fs.readFileSync(path.join(tmp, "data", "raw", "CaptureGuy.txt"), "utf8")).toBe(`${DIALOG_TEXT}\n\n-----\n\n${MODAL_TEXT}`);
    expect((await api("GET", "/status")).json.running).toBeNull();
    expect(fs.existsSync(path.join(tmp, "data", "logs", "publish.log"))).toBe(false);
  });

  it("answers 422 with a failed snapshot when nothing parses and the header is not zero", async () => {
    const r = await api("POST", "/capture", { version: 1, handle: "broken", scrapedAt: "2026-11-01T12:00:00Z", dialogText: "Stats\nCallouts\n12", modalText: "some unrelated text\nthat has no rows", blocks: [] });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ ok: false, error: "no callout rows parsed" });
    expect(db.prepare(`SELECT status, source, error FROM profile_snapshots WHERE handle = 'broken'`).get()).toEqual({ status: "failed", source: "import", error: "no callout rows parsed from capture" });
    expect(db.prepare(`SELECT status, notes FROM runs WHERE id = ?`).get(r.json.runId)).toEqual({ status: "failed", notes: "capture: broken" });
  });

  it("a zero-callout capture (header 0) is ok with zeroCallouts true; a capture with no text is 400", async () => {
    const r = await api("POST", "/capture", { version: 1, handle: "nobody", dialogText: "Callouts\n0\nTailers\n0\nTail volume\n$0", modalText: "No callouts", blocks: [] });
    expect(r.json).toMatchObject({ ok: true, rows: 0, zeroCallouts: true, header: { callouts: 0 } });
    expect((await api("POST", "/capture", { version: 1, handle: "x" })).status).toBe(400);
    expect((await api("POST", "/capture", { version: 1, modalText: MODAL_TEXT })).status).toBe(400);
    expect((await api("POST", "/capture", { version: 1, handle: "x", modalText: MODAL_TEXT, scrapedAt: "yesterday-ish" })).status).toBe(400);
  });
});
