import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, fromRoot, loadConfig, normalizeHandle, profileUrl, type Config } from "../config";
import { log as defaultLog } from "../log";
import { openDb, startRun, finishRun, upsertKol, insertRewardSnapshot, insertProfileSnapshot, storeProfileResult, allHandles, type DB } from "../db";
import { harvest, splitLines, parseHeaderTotals, toNum, type ParsedRow, type HeaderTotals } from "../parser";
import { exportBundle } from "../export";

/**
 * Local collector service (docs/collector-protocol.md).
 *
 * A browser-side client (the console script's POST /capture, or an extension driving
 * the documented run protocol) ships raw page text here; this service owns SQLite,
 * parsing (src/parser.ts), the JSON export and the publish step. Plain node:http,
 * bound to 127.0.0.1 only.
 */

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const STALE_RUN_MS = 3 * 3600e3;

export type Logger = Pick<typeof defaultLog, "info" | "warn" | "error" | "debug">;

export interface PendingRequest {
  handles?: string[];
  skipLeaderboard?: boolean;
  limit?: number;
  debug?: boolean;
  requestedAt: string;
}

interface RunState {
  runId: number;
  startedAt: string;
  /** profile currently being reported (for /status) */
  handle: string | null;
  request: PendingRequest | null;
  /** set when the request named handles: the whole plan, leaderboard skipped */
  explicitHandles: string[] | null;
  /** handles seen on the leaderboard in this run, in rank order */
  ranked: string[];
  ok: number;
  failed: number;
  failures: { handle: string; error: string }[];
  views: string[];
  endpoints: number;
  /** true when adopted from the runs table after a restart (counters unknown) */
  recovered: boolean;
}

export interface CollectorOptions {
  db?: DB;
  port?: number;
  host?: string;
  cfg?: Config;
  /** data directory (raw/, runs/, logs/, discovered_endpoints.json); default <repo>/data */
  dataDir?: string;
  /** spawn `npm run publish` after a finished run (default true) */
  publish?: boolean;
  logger?: Logger;
  version?: string;
  now?: () => Date;
}

export interface Collector {
  server: http.Server;
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
  /** current in-memory state (read-only use) */
  readonly state: { running: RunState | null; requested: PendingRequest | null };
}

// ---------------------------------------------------------------- due-ness

export interface DueInput {
  now: Date;
  requested: boolean;
  running: boolean;
  /** started_at of the most recent finished (non-running) run */
  lastStartedAt: Date | null;
  /** finished_at of that run */
  lastFinishedAt: Date | null;
  intervalHours: number;
  scheduleHourLocal: number;
}
export type DueReason = "requested" | "interval" | "";

const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Protocol: due when a run was requested, or when `scrapeIntervalHours` have passed
 * since the last finished run and local time is at/after `scheduleHourLocal` on a day
 * with no finished run yet. Never due while a run is in progress. The interval is
 * measured from the last finished run's *start* so a daily run does not creep later
 * every day by its own duration; the "no finished run today" gate uses its finish time.
 * With no finished run at all the interval is treated as elapsed (hour gate still applies).
 */
export function computeDue(i: DueInput): { due: boolean; reason: DueReason } {
  if (i.running) return { due: false, reason: "" };
  if (i.requested) return { due: true, reason: "requested" };
  if (i.now.getHours() < i.scheduleHourLocal) return { due: false, reason: "" };
  if (i.lastFinishedAt && sameLocalDay(i.lastFinishedAt, i.now)) return { due: false, reason: "" };
  const since = i.lastStartedAt ?? i.lastFinishedAt;
  if (since && i.now.getTime() - since.getTime() < i.intervalHours * 3600e3) return { due: false, reason: "" };
  return { due: true, reason: "interval" };
}

// ---------------------------------------------------------------- endpoint URLs

/** Same idea as scraper/discovery.ts templateUrl: redact query values, template the handle and long ids. */
export function templateEndpointUrl(raw: string, handle: string | null): { url: string; host: string; path: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let p = u.pathname;
  if (handle) p = p.split(encodeURIComponent(handle)).join(":handle").split(handle).join(":handle");
  p = p.replace(/\/[A-Za-z0-9_-]{25,}(?=\/|$)/g, "/:id");
  const q = [...new Set(u.searchParams.keys())].sort().map((k) => `${k}=<v>`).join("&");
  return { url: `${u.protocol}//${u.host}${p}${q ? "?" + q : ""}`, host: u.host, path: p };
}

interface EndpointRec { url: string; method: string; hits: number; firstSeen: string; lastSeen: string; matched: string[]; looksLikeCallouts: boolean; shape: unknown; host: string; path: string; [k: string]: unknown }

/** Merge page-observed endpoint URLs into discovered_endpoints.json (file shape of discovery.ts). Returns known count. */
export function mergeEndpoints(file: string, urls: string[], handle: string | null, now = new Date()): number {
  let prev: EndpointRec[] = [];
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")).endpoints ?? []; } catch { /* first time */ }
  const merged = new Map<string, EndpointRec>();
  for (const r of prev) merged.set(`${r.method} ${r.url}`, r);
  const ts = now.toISOString();
  const seenNow = new Set<string>();
  for (const raw of urls) {
    const t = templateEndpointUrl(raw, handle);
    if (!t) continue;
    const key = `GET ${t.url}`;
    if (seenNow.has(key)) continue; // one hit per page visit per template
    seenNow.add(key);
    const old = merged.get(key);
    if (old) { old.hits = (old.hits ?? 0) + 1; old.lastSeen = ts; }
    else merged.set(key, { url: t.url, method: "GET", hits: 1, firstSeen: ts, lastSeen: ts, matched: ["page"], looksLikeCallouts: false, shape: null, host: t.host, path: t.path });
  }
  if (seenNow.size === 0) return merged.size;
  const endpoints = [...merged.values()].sort((a, b) => b.hits - a.hits);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ updatedAt: ts, note: "Response shapes are keys only, no values.", endpoints }, null, 2));
  return endpoints.length;
}

// ---------------------------------------------------------------- helpers

/**
 * A client block is `lines[i-6 .. i+3]` around row i, so the *previous* row inside it is
 * usually cut at the top: harvest() then names it "?" (and may lose its age) and keys it
 * differently from the same row seen whole in modalText, which would double-count it.
 * Drop a nameless row when a named row has the same stats line (and age, if the
 * nameless one has one). A nameless row with no named twin is kept: better than losing it.
 */
export function dropCutDuplicates(rows: ParsedRow[]): ParsedRow[] {
  const named = rows.filter((r) => r.name !== "?");
  const twin = (q: ParsedRow) => named.some((r) => r.raw === q.raw && r.mult === q.mult && (q.ageDays === null || r.ageDays === q.ageDays));
  return rows.filter((r) => r.name !== "?" || !twin(r));
}

export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Leaderboard reward for one entry. The client may send `rewards` as a number, or
 * `rewards: null` plus `rewardsText` ("$1.2K", "12.5 SOL"); the text is parsed with
 * parser.ts toNum after stripping a SOL suffix. `unit` is taken as sent, else inferred
 * from the text ($ -> USD, SOL -> SOL).
 */
export function parseReward(e: { rewards?: unknown; rewardsText?: unknown; unit?: unknown }): { rewards: number | null; unit: string | null } {
  const text = typeof e.rewardsText === "string" ? e.rewardsText.trim() : "";
  let rewards = typeof e.rewards === "number" && Number.isFinite(e.rewards) ? e.rewards : null;
  if (rewards === null && text) rewards = toNum(text.replace(/\s*SOL\s*$/i, "").trim());
  let unit = typeof e.unit === "string" && e.unit ? e.unit : null;
  if (unit === null && text) unit = /\bSOL\b/i.test(text) ? "SOL" : text.includes("$") ? "USD" : null;
  return { rewards, unit };
}

class HttpError extends Error { constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); } }

type Body = Record<string, any>;
interface Ctx { params: Record<string, string>; body: Body; query: URLSearchParams }
type Resp = { status: number; body: unknown };
type Handler = (ctx: Ctx) => Resp | Promise<Resp>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

const ok = (body: unknown, status = 200): Resp => ({ status, body });
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function compile(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const src = pattern.split("/").map((seg) => {
    if (seg.startsWith(":")) { keys.push(seg.slice(1)); return "([^/]+)"; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { method, re: new RegExp(`^${src}/?$`), keys, handler };
}

function readBody(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, `body too large (limit ${MAX_BODY_BYTES} bytes)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size === 0) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!v || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "body must be a JSON object"));
        resolve(v as Body);
      } catch (e) { reject(new HttpError(400, `invalid JSON body: ${(e as Error).message}`)); }
    });
    req.on("error", reject);
  });
}

function readVersion(): string {
  try { return JSON.parse(fs.readFileSync(fromRoot("package.json"), "utf8")).version ?? "0.0.0"; } catch { return "0.0.0"; }
}

// ---------------------------------------------------------------- factory

export function createCollector(opts: CollectorOptions = {}): Collector {
  const cfg = opts.cfg ?? loadConfig();
  const logger = opts.logger ?? defaultLog;
  const now = opts.now ?? (() => new Date());
  const version = opts.version ?? readVersion();
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? cfg.collectorPort ?? 47831;
  const publish = opts.publish !== false;
  const dataDir = opts.dataDir ?? fromRoot("data");
  const rawDir = path.join(dataDir, "raw");
  const runsDir = path.join(dataDir, "runs");
  const logsDir = path.join(dataDir, "logs");
  const endpointsPath = path.join(dataDir, "discovered_endpoints.json");
  for (const d of [dataDir, rawDir, runsDir, logsDir]) fs.mkdirSync(d, { recursive: true });

  const ownsDb = !opts.db;
  const db = opts.db ?? openDb();

  const state: { running: RunState | null; requested: PendingRequest | null } = { running: null, requested: null };

  // ---- recovery: adopt a run left `running` by a previous process
  const runningRows = () => db.prepare(`SELECT id, started_at FROM runs WHERE status = 'running' ORDER BY id DESC`).all() as { id: number; started_at: string }[];
  const adopt = (row: { id: number; started_at: string }): RunState => ({
    runId: row.id, startedAt: row.started_at, handle: null, request: null, explicitHandles: null, ranked: [], ok: 0, failed: 0, failures: [], views: [], endpoints: 0, recovered: true,
  });
  {
    const rows = runningRows();
    if (rows.length) {
      state.running = adopt(rows[0]);
      logger.info(`collector: recovered running run ${rows[0].id} (started ${rows[0].started_at}) from the database`);
    }
  }

  // ---- queries
  const lastFinished = () => db.prepare(`SELECT * FROM runs WHERE status != 'running' ORDER BY id DESC LIMIT 1`).get() as any | undefined;
  const kolCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM kols`).get() as any).n as number;
  const due = () => {
    const last = lastFinished();
    return computeDue({
      now: now(),
      requested: !!state.requested,
      running: !!state.running,
      lastStartedAt: last?.started_at ? new Date(last.started_at) : null,
      lastFinishedAt: last?.finished_at ? new Date(last.finished_at) : null,
      intervalHours: cfg.scrapeIntervalHours,
      scheduleHourLocal: cfg.scheduleHourLocal ?? 6,
    });
  };

  /** The run `:id` refers to; adopts a DB-running row if this process does not know it. */
  const requireRun = (idRaw: string): RunState => {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "bad run id");
    if (state.running && state.running.runId === id) return state.running;
    const row = db.prepare(`SELECT id, started_at FROM runs WHERE id = ? AND status = 'running'`).get(id) as { id: number; started_at: string } | undefined;
    if (!row) throw new HttpError(404, `run ${id} is not running`, { runId: id });
    if (state.running) logger.warn(`collector: run ${id} reported while run ${state.running.runId} was current; switching`);
    state.running = adopt(row);
    logger.info(`collector: adopted running run ${id} from the database`);
    return state.running;
  };

  const planHandles = (run: RunState): string[] => {
    const exclude = new Set(cfg.excludeHandles);
    let handles: string[];
    if (run.explicitHandles) handles = [...run.explicitHandles];
    else {
      for (const h of cfg.includeHandles) upsertKol(db, { handle: h, profileUrl: profileUrl(h), source: "config" });
      handles = [...run.ranked, ...cfg.includeHandles, ...allHandles(db)].filter((h, i, a) => a.indexOf(h) === i);
    }
    handles = handles.filter((h) => h && !exclude.has(h));
    const cap = run.request?.limit ?? cfg.maxProfilesPerRun;
    if (cap && handles.length > cap) handles = handles.slice(0, cap);
    return handles;
  };

  const parseCaptureRows = (modalText: string, blocks: string[], at: Date): ParsedRow[] => {
    const rows = new Map<string, ParsedRow>();
    if (modalText) harvest(splitLines(modalText), rows, at);
    for (const b of blocks) harvest(splitLines(b), rows, at);
    return dropCutDuplicates([...rows.values()]);
  };

  const writeRaw = (handle: string, dialogText: string, modalText: string) => {
    fs.writeFileSync(path.join(rawDir, `${safeName(handle)}.txt`), `${dialogText}\n\n-----\n\n${modalText}`);
  };

  const headerOut = (h: HeaderTotals) => ({ callouts: h.callouts, tailers: h.tailers, tailVolume: h.tailVolume });

  const spawnPublish = (runId: number) => {
    if (!publish) { logger.info(`collector: publish disabled; skipping npm run publish for run ${runId}`); return; }
    try {
      const file = path.join(logsDir, "publish.log");
      const fd = fs.openSync(file, "a");
      fs.writeSync(fd, `\n=== ${now().toISOString()} publish after run ${runId} ===\n`);
      const child = spawn("npm", ["run", "publish"], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.on("error", (e) => logger.error(`collector: publish failed to start: ${String(e)}`));
      child.on("exit", (code) => logger.info(`collector: publish for run ${runId} exited with ${code}`));
      child.unref();
      fs.closeSync(fd);
      logger.info(`collector: spawned npm run publish (pid ${child.pid}) for run ${runId}; output -> ${file}`);
    } catch (e) {
      logger.error(`collector: could not spawn publish: ${String(e)}`);
    }
  };

  // ---------------------------------------------------------------- handlers

  const routes: Route[] = [];
  const on = (method: string, pattern: string, handler: Handler) => routes.push(compile(method, pattern, handler));

  on("GET", "/status", () => {
    const last = lastFinished();
    const d = due();
    return ok({
      ok: true,
      version,
      running: state.running ? { runId: state.running.runId, startedAt: state.running.startedAt, handle: state.running.handle } : null,
      lastRun: last ? { id: last.id, startedAt: last.started_at, finishedAt: last.finished_at, status: last.status, profilesTotal: last.profiles_total, profilesOk: last.profiles_ok, profilesFailed: last.profiles_failed } : null,
      due: d.due,
      dueReason: d.reason,
      requested: state.requested,
      kols: kolCount(),
      collectorHost: os.hostname(),
    });
  });

  on("GET", "/due", () => {
    const d = due();
    return ok({ due: d.due, reason: d.reason, request: state.requested });
  });

  on("POST", "/request-run", ({ body }) => {
    const handles = strArray(body.handles).map(normalizeHandle).filter(Boolean);
    const req: PendingRequest = { requestedAt: now().toISOString() };
    if (handles.length) req.handles = handles;
    if (body.skipLeaderboard === true || handles.length) req.skipLeaderboard = true;
    const limit = num(body.limit);
    if (limit !== null && limit > 0) req.limit = Math.floor(limit);
    if (body.debug === true) req.debug = true;
    state.requested = req;
    logger.info(`collector: run requested ${JSON.stringify(req)}`);
    return ok({ ok: true });
  });

  on("POST", "/run/start", ({ body }) => {
    // stale / concurrent runs
    for (const row of runningRows()) {
      const age = now().getTime() - Date.parse(row.started_at);
      if (age < STALE_RUN_MS) {
        logger.warn(`collector: /run/start refused, run ${row.id} in progress since ${row.started_at}`);
        return { status: 409, body: { error: "run in progress", runId: row.id } };
      }
      const prev = state.running?.runId === row.id ? state.running : null;
      finishRun(db, row.id, { status: "failed", total: (prev?.ok ?? 0) + (prev?.failed ?? 0), ok: prev?.ok ?? 0, failed: prev?.failed ?? 0, notes: "abandoned" });
      logger.warn(`collector: run ${row.id} (started ${row.started_at}) marked failed: abandoned`);
      if (prev) state.running = null;
    }
    state.running = null;

    const reqIn = body.request && typeof body.request === "object" ? (body.request as Body) : null;
    const pending = state.requested;
    const source = str(body.source) ?? "unknown";
    const extVersion = str(body.extensionVersion) ?? "?";
    let request: PendingRequest | null = null;
    if (reqIn) {
      request = { requestedAt: str(reqIn.requestedAt) ?? pending?.requestedAt ?? now().toISOString() };
      const hs = strArray(reqIn.handles).map(normalizeHandle).filter(Boolean);
      if (hs.length) request.handles = hs;
      if (reqIn.skipLeaderboard === true) request.skipLeaderboard = true;
      const lim = num(reqIn.limit);
      if (lim !== null && lim > 0) request.limit = Math.floor(lim);
      if (reqIn.debug === true) request.debug = true;
    } else if (pending) {
      request = pending; // the client started without echoing the request: honour the pending one rather than lose it
    }
    state.requested = null;

    const explicit = request?.handles?.length ? request.handles : null;
    const notes = `${source}${extVersion !== "?" ? ` ${extVersion}` : ""}${explicit ? `; handles: ${explicit.join(",")}` : ""}`;
    const runId = startRun(db, notes);
    const startedAt = (db.prepare(`SELECT started_at FROM runs WHERE id = ?`).get(runId) as any).started_at as string;
    const run: RunState = { runId, startedAt, handle: null, request, explicitHandles: explicit, ranked: [], ok: 0, failed: 0, failures: [], views: [], endpoints: 0, recovered: false };
    state.running = run;
    const skipLeaderboard = !!explicit || request?.skipLeaderboard === true;
    const handles = explicit ? planHandles(run) : [];
    logger.info(`collector: run ${runId} started by ${source} ${extVersion}${explicit ? ` for ${handles.length} handle(s)` : skipLeaderboard ? " (leaderboard skipped)" : ""}`);
    return ok({
      runId,
      leaderboardViews: cfg.leaderboardViews,
      skipLeaderboard,
      delayMs: cfg.delayBetweenProfilesMs,
      maxRetriesPerProfile: cfg.maxRetriesPerProfile,
      debug: request?.debug === true,
      handles,
    });
  });

  on("POST", "/run/:id/leaderboard", ({ params, body }) => {
    const run = requireRun(params.id);
    const view = str(body.view);
    if (!view) throw new HttpError(400, "view is required");
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const seen = new Set<string>();
    let skipped = 0;
    const tx = db.transaction(() => {
      for (const e of entries) {
        if (!e || typeof e !== "object") { skipped++; continue; }
        const handle = normalizeHandle(str(e.handle) ?? "");
        if (!handle) { skipped++; continue; }
        try {
          upsertKol(db, { handle, displayName: str(e.displayName), avatarUrl: str(e.avatarUrl), profileUrl: profileUrl(handle), source: "leaderboard" });
          const { rewards, unit } = parseReward(e);
          insertRewardSnapshot(db, { handle, runId: run.runId, view, rank: num(e.rank), rewards, unit, raw: (str(e.raw) ?? "").slice(0, 300) });
          seen.add(handle);
          if (!run.ranked.includes(handle)) run.ranked.push(handle);
        } catch (err) {
          skipped++;
          logger.warn(`collector: run ${run.runId} leaderboard ${view}: bad entry ${JSON.stringify(e).slice(0, 200)}: ${String(err)}`);
        }
      }
    });
    tx();
    const rawText = str(body.rawText);
    if (rawText) fs.writeFileSync(path.join(rawDir, `leaderboard-${safeName(view)}.txt`), rawText.slice(0, 200 * 1024));
    if (!run.views.includes(view)) run.views.push(view);
    logger.info(`collector: run ${run.runId} leaderboard ${view}: ${seen.size} handles${skipped ? `, ${skipped} entries skipped` : ""} (${run.ranked.length} ranked so far)`);
    return ok({ ok: true, handles: seen.size });
  });

  on("GET", "/run/:id/handles", ({ params }) => {
    const run = requireRun(params.id);
    const handles = planHandles(run);
    logger.info(`collector: run ${run.runId} plan: ${handles.length} profiles`);
    return ok({ handles });
  });

  on("POST", "/run/:id/profile", ({ params, body }) => {
    const run = requireRun(params.id);
    const handle = normalizeHandle(str(body.handle) ?? "");
    if (!handle) throw new HttpError(400, "handle is required");
    run.handle = handle;
    const attempt = Math.max(1, Math.floor(num(body.attempt) ?? 1));
    const maxRetries = cfg.maxRetriesPerProfile;
    const bodyStatus = str(body.status) ?? "ok";
    const error = str(body.error);
    const tag = `collector: run ${run.runId} ${handle} attempt ${attempt}/${maxRetries}`;

    const fail = (reason: string): Resp => {
      insertProfileSnapshot(db, { handle, runId: run.runId, status: "failed", error: reason });
      run.failed++;
      run.failures.push({ handle, error: reason });
      logger.warn(`${tag}: failed: ${reason}`);
      return ok({ status: "failed", reason });
    };
    const retryOrFail = (reason: string): Resp => {
      if (attempt < maxRetries) { logger.warn(`${tag}: retry: ${reason}`); return ok({ status: "retry", reason }); }
      return fail(reason);
    };

    if (bodyStatus === "notfound") return fail(error ?? "profile not found");
    if (bodyStatus === "failed") return retryOrFail(error ?? "client reported failure");

    const modalText = str(body.modalText) ?? "";
    const dialogText = str(body.dialogText) ?? "";
    const blocks = strArray(body.blocks);
    const pageState = str(body.state) ?? "unknown";
    const at = now();
    const rows = parseCaptureRows(modalText, blocks, at);
    const header = parseHeaderTotals(splitLines(dialogText || modalText));
    writeRaw(handle, dialogText, modalText);
    const shot = str(body.screenshotDataUrl);
    if (shot) {
      const m = shot.match(/^data:image\/(png|jpe?g);base64,(.+)$/s);
      if (m) { try { fs.writeFileSync(path.join(rawDir, `${safeName(handle)}.client.${m[1] === "png" ? "png" : "jpg"}`), Buffer.from(m[2], "base64")); } catch { /* best effort */ } }
    }
    const endpointUrls = strArray(body.endpoints);
    if (endpointUrls.length) {
      try { run.endpoints = mergeEndpoints(endpointsPath, endpointUrls, handle, at); } catch (e) { logger.warn(`${tag}: could not record endpoints: ${String(e)}`); }
    }

    const zeroCallouts = rows.length === 0 && (pageState === "empty" || header.callouts === 0);
    if (rows.length > 0 || zeroCallouts) {
      upsertKol(db, { handle, displayName: str(body.displayName), avatarUrl: str(body.avatarUrl), profileUrl: str(body.url) ?? profileUrl(handle), source: run.explicitHandles ? "config" : "leaderboard" });
      storeProfileResult(db, handle, run.runId, rows, header, "dom", at);
      run.ok++;
      logger.info(`${tag}: ok, ${rows.length} callouts (header: ${header.callouts ?? "?"} callouts, ${header.tailers ?? "?"} tailers, tail volume ${header.tailVolume ?? "?"}; ${num(body.iterations) ?? "?"} scroll steps, ${num(body.durationMs) ?? "?"} ms)`);
      return ok({ status: "ok", rows: rows.length, header: headerOut(header), zeroCallouts });
    }
    return retryOrFail(`no rows parsed (state=${pageState}, header callouts=${header.callouts ?? "?"})`);
  });

  on("POST", "/run/:id/finish", ({ params, body }) => {
    const run = requireRun(params.id);
    const failures = Array.isArray(body.failures)
      ? body.failures.filter((f: any) => f && typeof f === "object").map((f: any) => ({ handle: normalizeHandle(str(f.handle) ?? ""), error: str(f.error) ?? "" }))
      : run.failures;
    const aborted = body.aborted === true;
    const okN = num(body.ok) ?? run.ok;
    const failedN = num(body.failed) ?? Math.max(run.failed, failures.length);
    const total = num(body.total) ?? okN + failedN;
    const status = aborted ? "failed" : failedN > 0 ? "partial" : "ok";
    finishRun(db, run.runId, { status, total, ok: okN, failed: failedN, notes: aborted ? "aborted" : undefined });
    const finishedAt = (db.prepare(`SELECT finished_at FROM runs WHERE id = ?`).get(run.runId) as any).finished_at as string;
    state.running = null;

    const summary = {
      runId: run.runId, status, total, ok: okN, failed: failedN, failures, startedAt: run.startedAt, finishedAt,
      leaderboardHandles: run.ranked.length, leaderboardViews: run.views, endpoints: run.endpoints, fatal: aborted ? "aborted by client" : null,
      source: "collector", recovered: run.recovered,
    };
    try { fs.writeFileSync(path.join(runsDir, `${run.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2)); }
    catch (e) { logger.error(`collector: could not write run summary: ${String(e)}`); }

    let exported: { kols: number; callouts: number } | null = null;
    let exportError: string | null = null;
    try {
      const r = exportBundle(db, cfg, { now: now() });
      exported = { kols: r.kols, callouts: r.callouts };
      logger.info(`collector: exported ${r.kols} KOLs / ${r.callouts} callouts to ${r.outDir}`);
    } catch (e) {
      exportError = String(e);
      logger.error(`collector: export failed: ${exportError}`);
    }
    logger.info(`collector: run ${run.runId} ${status}: ${okN}/${total} profiles ok, ${failedN} failed`);
    spawnPublish(run.runId);
    return ok({ ok: true, status, exported, ...(exportError ? { exportError } : {}) });
  });

  on("POST", "/capture", ({ body }) => {
    const handle = normalizeHandle(str(body.handle) ?? "");
    if (!handle) throw new HttpError(400, "capture has no handle");
    const modalText = str(body.modalText) ?? "";
    const blocks = strArray(body.blocks);
    if (!modalText && blocks.length === 0) throw new HttpError(400, "capture has no modalText or blocks");
    const dialogText = str(body.dialogText) ?? "";
    const scrapedAtRaw = str(body.scrapedAt);
    const scrapedAt = scrapedAtRaw ? new Date(scrapedAtRaw) : now();
    if (Number.isNaN(scrapedAt.getTime())) throw new HttpError(400, `bad scrapedAt "${scrapedAtRaw}"`);

    const rows = parseCaptureRows(modalText, blocks, scrapedAt);
    const header = parseHeaderTotals(splitLines(dialogText || modalText));
    writeRaw(handle, dialogText, modalText);
    const runId = startRun(db, `capture: ${handle}`);
    upsertKol(db, { handle, displayName: str(body.displayName), avatarUrl: str(body.avatarUrl), profileUrl: str(body.url) ?? profileUrl(handle), source: "config" });
    if (rows.length === 0 && header.callouts !== 0 && !/no callouts/i.test(modalText)) {
      insertProfileSnapshot(db, { handle, runId, status: "failed", error: "no callout rows parsed from capture", source: "import" });
      finishRun(db, runId, { status: "failed", total: 1, ok: 0, failed: 1 });
      logger.warn(`collector: capture ${handle} (run ${runId}): no callout rows parsed`);
      return { status: 422, body: { ok: false, error: "no callout rows parsed", runId } };
    }
    storeProfileResult(db, handle, runId, rows, header, "import", scrapedAt);
    finishRun(db, runId, { status: "ok", total: 1, ok: 1, failed: 0 });
    let exported: { kols: number; callouts: number } | null = null;
    try {
      const r = exportBundle(db, cfg, { now: now() });
      exported = { kols: r.kols, callouts: r.callouts };
    } catch (e) { logger.error(`collector: export after capture failed: ${String(e)}`); }
    const zeroCallouts = rows.length === 0;
    logger.info(`collector: capture ${handle} (run ${runId}): ${rows.length} callouts (header ${header.callouts ?? "?"}/${header.tailers ?? "?"}/${header.tailVolume ?? "?"}) as of ${scrapedAt.toISOString()}${exported ? `; exported ${exported.kols} KOLs` : ""}`);
    return ok({ ok: true, runId, rows: rows.length, header: headerOut(header), zeroCallouts, exported });
  });

  on("POST", "/log", ({ body }) => {
    const level = str(body.level) ?? "info";
    const message = str(body.message) ?? JSON.stringify(body);
    const runId = num(body.runId);
    const line = `[ext]${runId !== null ? ` [run ${runId}]` : ""} ${message}`;
    if (level === "error") logger.error(line);
    else if (level === "warn") logger.warn(line);
    else if (level === "debug") logger.debug(line);
    else logger.info(line);
    return ok({ ok: true });
  });

  // ---------------------------------------------------------------- http plumbing

  const cors = (res: http.ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  };
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${host}`);
    cors(res);
    res.on("finish", () => logger.debug(`${method} ${url.pathname}${url.search} -> ${res.statusCode} ${Date.now() - t0}ms`));
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      let matched: Route | undefined;
      let params: Record<string, string> = {};
      let pathMatched = false;
      for (const r of routes) {
        const m = url.pathname.match(r.re);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        matched = r;
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        break;
      }
      if (!matched) {
        if (pathMatched) { res.setHeader("Allow", routes.filter((r) => url.pathname.match(r.re)).map((r) => r.method).join(", ")); return send(res, 405, { error: "method not allowed" }); }
        return send(res, 404, { error: "not found" });
      }
      const body = method === "POST" || method === "PUT" || method === "PATCH" ? await readBody(req) : {};
      const out = await matched.handler({ params, body, query: url.searchParams });
      send(res, out.status, out.body);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      logger.error(`collector: ${method} ${url.pathname} failed: ${(e as Error)?.stack ?? String(e)}`);
      send(res, 500, { error: (e as Error)?.message ?? String(e) });
    }
  });
  server.keepAliveTimeout = 5000;

  let started = false;
  return {
    server,
    state,
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        started = true;
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        const url = `http://${host}:${p}`;
        logger.info(`collector: listening on ${url} (data dir ${dataDir}, publish ${publish ? "on" : "off"})`);
        resolve({ port: p, url });
      });
    }),
    stop: () => new Promise((resolve) => {
      const done = () => { if (ownsDb) { try { db.close(); } catch { /* already closed */ } } logger.info("collector: stopped"); resolve(); };
      if (!started) return done();
      server.close(() => done());
      server.closeAllConnections?.();
    }),
  };
}
