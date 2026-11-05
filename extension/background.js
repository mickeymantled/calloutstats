// Callout Check collector: background service worker (Manifest V3).
//
// Runs a collection pass inside this browser's own pump.fun session (the
// dedicated Chrome profile the owner logged into by hand) and talks to the local
// collector service, which owns parsing, SQLite, export and publish. The
// contract is docs/collector-protocol.md in the repo.
//
// Basis: pump.fun's team told the project owner that collecting tailer PNL this
// way, as other user-side tools do, is acceptable. This worker only opens public
// profile pages the user could open themselves, with a 2-4 s pause between
// profiles. It never touches a Cloudflare challenge: if a verification page
// shows up, the profile is reported as failed and the run moves on.

const DEFAULT_BASE = "http://127.0.0.1:47831";
const VERSION = chrome.runtime.getManifest().version;
const POLL_ALARM = "cc-poll";
const PROFILE_TIMEOUT_MS = 27 * 60_000; // pump.fun rate-limits the list (~5 pages, then a pause of minutes); content-profile.js stops itself after 25
const LEADERBOARD_TIMEOUT_MS = 5 * 60_000;
const NAV_TIMEOUT_MS = 60_000;

let active = false; // a loop is running in this worker instance
let keepAliveTimer = null;
const pending = new Map(); // token -> { resolve, reject, timer }

// ---------- lifecycle ----------
chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());
ensureAlarm();

function ensureAlarm() {
  chrome.alarms.get(POLL_ALARM, (a) => {
    if (!a) chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) tick().catch((e) => log("error", `tick: ${e.message}`));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "result") {
    const p = pending.get(msg.token);
    if (p) { clearTimeout(p.timer); pending.delete(msg.token); p.resolve(msg.result); }
    return;
  }
  if (msg.type === "progress") {
    // content scripts report progress every few seconds; the event also keeps this worker alive
    console.debug("[content]", msg.msg);
    return;
  }
  if (msg.type === "runNow") {
    (async () => {
      try {
        await api("POST", "/request-run", msg.request ?? {});
        await tick(true);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === "state") {
    getRun().then((run) => sendResponse({ active, run })).catch((e) => sendResponse({ active, error: e.message }));
    return true;
  }
});

// ---------- collector API ----------
async function base() {
  const { collectorUrl } = await chrome.storage.local.get("collectorUrl");
  return (collectorUrl || DEFAULT_BASE).replace(/\/$/, "");
}

async function api(method, path, body) {
  const res = await fetch((await base()) + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${json?.error ?? text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function log(level, message, runId) {
  const line = `[ext] ${message}`;
  if (level === "error") console.error(line); else console.log(line);
  try { await api("POST", "/log", { level, message, runId: runId ?? null }); } catch { /* collector down; already on console */ }
}

// ---------- run state (survives worker restarts, not browser restarts) ----------
const getRun = async () => (await chrome.storage.session.get("run")).run ?? null;
const setRun = (run) => chrome.storage.session.set({ run });
const clearRun = () => chrome.storage.session.remove("run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo + 1));

function startKeepAlive() {
  stopKeepAlive();
  // an extension API call every 20 s resets the worker's idle timer during long scrolls
  keepAliveTimer = setInterval(() => { chrome.storage.session.get("run").catch(() => {}); }, 20_000);
}
function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ---------- scheduling ----------
async function tick(force = false) {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  if (!enabled && !force) return;
  if (active) return;
  const run = await getRun();
  if (run) return resume(run);
  const due = await api("GET", "/due");
  if (!due?.due) return;
  await startRun(due.request ?? null, due.reason || "due");
}

async function startRun(request, reason) {
  let plan;
  try {
    plan = await api("POST", "/run/start", { source: "extension", extensionVersion: VERSION, request });
  } catch (e) {
    if (e.status === 409) { await log("warn", `collector says a run is already in progress (run ${e.body?.runId})`); return; }
    throw e;
  }
  const { windowId, tabId } = await openWindow();
  const run = {
    runId: plan.runId,
    plan,
    phase: plan.skipLeaderboard || (plan.handles && plan.handles.length) ? "profiles" : "leaderboard",
    handles: plan.handles ?? [],
    index: 0,
    ok: 0,
    failed: 0,
    failures: [],
    windowId,
    tabId,
    startedAt: new Date().toISOString(),
  };
  await setRun(run);
  await log("info", `run ${run.runId} started (${reason}): ${run.phase === "leaderboard" ? "leaderboard first" : run.handles.length + " handles"}`, run.runId);
  await loop(run);
}

async function resume(run) {
  // worker was restarted mid-run; make sure the window is still there
  let ok = false;
  try { await chrome.windows.get(run.windowId); await chrome.tabs.get(run.tabId); ok = true; } catch { /* gone */ }
  if (!ok) {
    const { windowId, tabId } = await openWindow();
    run.windowId = windowId;
    run.tabId = tabId;
    await setRun(run);
  }
  await log("info", `resuming run ${run.runId} at ${run.phase} ${run.index}/${run.handles.length}`, run.runId);
  await loop(run);
}

async function openWindow() {
  // a normal, unfocused but visible window: background tabs get their timers throttled
  const win = await chrome.windows.create({ url: "about:blank", focused: false, width: 1100, height: 900, type: "normal" });
  return { windowId: win.id, tabId: win.tabs[0].id };
}

// ---------- the run loop ----------
async function loop(run) {
  if (active) return;
  active = true;
  startKeepAlive();
  try {
    for (;;) {
      if (run.phase === "leaderboard") {
        await doLeaderboard(run);
        run.phase = "profiles";
        await setRun(run);
        continue;
      }
      if (run.phase === "profiles") {
        if (run.index >= run.handles.length) { run.phase = "finish"; await setRun(run); continue; }
        await doProfile(run, run.handles[run.index]);
        run.index++;
        await setRun(run);
        if (run.index < run.handles.length) await sleep(rand(run.plan.delayMs || [2000, 4000]));
        continue;
      }
      await doFinish(run, false);
      return;
    }
  } catch (e) {
    await log("error", `run ${run.runId} aborted: ${e.message}`, run.runId);
    run.failures.push({ handle: "*", error: e.message });
    try { await doFinish(run, true); } catch (e2) { await log("error", `finish failed: ${e2.message}`, run.runId); await clearRun(); }
  } finally {
    active = false;
    stopKeepAlive();
  }
}

async function doLeaderboard(run) {
  let result;
  try {
    await navigate(run.tabId, "https://pump.fun/leaderboard");
    result = await inject(run.tabId, "content-leaderboard.js", { views: run.plan.leaderboardViews || ["all", "monthly"] }, LEADERBOARD_TIMEOUT_MS);
  } catch (e) {
    if (isGone(e)) throw e;
    result = { ok: false, error: e.message, views: [] };
  }
  if (!result.ok) await log("warn", `leaderboard: ${result.error}`, run.runId);
  for (const v of result.views || []) {
    try {
      const r = await api("POST", `/run/${run.runId}/leaderboard`, { view: v.view, entries: v.entries, rawText: v.rawText });
      await log("info", `leaderboard[${v.view}]: ${v.entries.length} entries, ${r.handles} handles stored`, run.runId);
    } catch (e) {
      await log("warn", `leaderboard[${v.view}] post failed: ${e.message}`, run.runId);
    }
  }
  const h = await api("GET", `/run/${run.runId}/handles`);
  run.handles = h.handles ?? [];
  await log("info", `${run.handles.length} profiles to collect`, run.runId);
}

async function doProfile(run, handle) {
  const url = `https://pump.fun/profile/${encodeURIComponent(handle)}`;
  const max = run.plan.maxRetriesPerProfile || 3;
  let last = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    const t0 = Date.now();
    let result;
    try {
      await navigate(run.tabId, url);
      result = await inject(run.tabId, "content-profile.js", { handle }, PROFILE_TIMEOUT_MS);
    } catch (e) {
      if (isGone(e)) throw e; // the user closed the window: abort the run cleanly
      result = { status: "failed", error: e.message };
    }
    const body = {
      handle,
      url,
      attempt,
      status: result.status ?? "failed",
      error: result.error ?? null,
      displayName: result.displayName ?? null,
      avatarUrl: result.avatarUrl ?? null,
      modalText: result.modalText ?? "",
      blocks: result.blocks ?? [],
      dialogText: result.dialogText ?? "",
      state: result.state ?? "unknown",
      iterations: result.iterations ?? 0,
      durationMs: Date.now() - t0,
      endpoints: result.endpoints ?? [],
      screenshotDataUrl: null,
    };
    let resp;
    try {
      resp = await api("POST", `/run/${run.runId}/profile`, body);
    } catch (e) {
      resp = { status: "failed", reason: `collector: ${e.message}` };
    }
    last = resp;
    if (resp.status === "retry" && attempt < max) {
      await log("warn", `${handle}: attempt ${attempt} -> retry (${resp.reason})`, run.runId);
      // a retry is usually pump.fun refusing the callouts request (rate limit): back off
      await sleep(rand([30_000, 60_000]) * attempt);
      continue;
    }
    break;
  }
  const pos = `[${run.index + 1}/${run.handles.length}]`;
  if (last?.status === "ok") {
    run.ok++;
    await log("info", `${pos} ${handle}: ${last.rows} rows (header callouts ${last.header?.callouts ?? "?"}, tailers ${last.header?.tailers ?? "?"})`, run.runId);
  } else {
    run.failed++;
    run.failures.push({ handle, error: last?.reason ?? last?.error ?? "unknown" });
    await log("warn", `${pos} ${handle}: failed (${last?.reason ?? last?.error ?? "unknown"})`, run.runId);
  }
}

async function doFinish(run, aborted) {
  const total = run.handles.length;
  let resp = null;
  try {
    resp = await api("POST", `/run/${run.runId}/finish`, { total, ok: run.ok, failed: run.failed, aborted, failures: run.failures });
  } catch (e) {
    await log("error", `finish post failed: ${e.message}`, run.runId);
  }
  try { await chrome.windows.remove(run.windowId); } catch { /* already closed */ }
  await chrome.storage.local.set({
    lastRunSummary: { runId: run.runId, finishedAt: new Date().toISOString(), total, ok: run.ok, failed: run.failed, aborted, status: resp?.status ?? "unknown" },
    lastError: aborted ? (run.failures[run.failures.length - 1]?.error ?? null) : null,
  });
  await clearRun();
  await log("info", `run ${run.runId} finished: ${run.ok}/${total} ok, ${run.failed} failed${aborted ? " (aborted)" : ""}`, run.runId);
}

// ---------- tab helpers ----------
const isGone = (e) => /No tab with id|No window with id|closed|Tabs cannot be edited/i.test(e?.message || "");

// Cloudflare sometimes shows its "Just a moment..." interstitial (seen on
// /leaderboard). This only waits, passively, for the page to move on by itself;
// it never touches the interstitial. If it stays, the content script reports
// "verification page shown" and the run goes on without that page.
const VERIFY_WAIT_MS = 45_000;
async function settleVerification(tabId) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + VERIFY_WAIT_MS;
  let sawIt = false;
  for (;;) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    const onIt = /just a moment/i.test(tab.title || "");
    if (!onIt && tab.status === "complete") { if (sawIt) await wait(800); return; }
    if (Date.now() > end) return;
    if (onIt && !sawIt) { sawIt = true; log("warn", `verification page on ${tab.url || "?"}; waiting up to ${VERIFY_WAIT_MS / 1000}s for it to clear`); }
    await wait(1000);
  }
}

function navigate(tabId, url) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`navigation timeout: ${url}`)), NAV_TIMEOUT_MS + VERIFY_WAIT_MS);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") setTimeout(() => settleVerification(tabId).then(() => done(resolve), () => done(resolve)), 800);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch((e) => done(reject, e));
  });
}

/**
 * Inject a content script file and wait for its {type:"result"} message.
 * Arguments travel through window.__ccArgs in the extension's isolated world,
 * which a func injection and a file injection share.
 */
async function inject(tabId, file, args, timeoutMs) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(token); reject(new Error(`${file} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    pending.set(token, { resolve, reject, timer });
  });
  await chrome.scripting.executeScript({ target: { tabId }, func: (a) => { window.__ccArgs = a; }, args: [{ ...args, token }] });
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  return result;
}
