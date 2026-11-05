// Popup: shows collector status and lets the user start a run by hand.
const $ = (id) => document.getElementById(id);
const DEFAULT_BASE = "http://127.0.0.1:47831";

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

async function load() {
  const { collectorUrl, enabled = true, lastRunSummary, lastError } = await chrome.storage.local.get(["collectorUrl", "enabled", "lastRunSummary", "lastError"]);
  $("url").value = collectorUrl || DEFAULT_BASE;
  $("enabled").checked = enabled;
  if (lastError) { $("msg").textContent = `last error: ${lastError}`; $("msg").className = "bad"; }

  // what this worker is doing
  chrome.runtime.sendMessage({ type: "state" }, (st) => {
    if (chrome.runtime.lastError || !st) return;
    if (st.run) {
      $("now").textContent = `run ${st.run.runId}: ${st.run.phase} ${st.run.index}/${st.run.handles.length}`;
      $("now").className = "warn";
    }
  });

  // collector status
  try {
    const res = await fetch((collectorUrl || DEFAULT_BASE).replace(/\/$/, "") + "/status");
    const s = await res.json();
    $("collector").textContent = `online (v${s.version ?? "?"})`;
    $("collector").className = "ok";
    $("kols").textContent = s.kols ?? "—";
    const lr = s.lastRun || lastRunSummary;
    $("lastRun").textContent = lr ? `${fmtTime(lr.finishedAt)} · ${lr.profilesOk ?? lr.ok}/${lr.profilesTotal ?? lr.total} ok` : "never";
    $("due").textContent = s.requested ? "requested" : s.due ? "yes" : "no";
    if (s.running) { $("now").textContent = `collector: run ${s.running.runId} (${s.running.handle ?? "…"})`; $("now").className = "warn"; }
  } catch (e) {
    $("collector").textContent = "offline (start `npm run collector`)";
    $("collector").className = "bad";
    $("run").disabled = true;
    $("runOne").disabled = true;
  }
}

function runNow(request) {
  $("msg").textContent = "starting…";
  $("msg").className = "muted";
  chrome.runtime.sendMessage({ type: "runNow", request }, (r) => {
    if (chrome.runtime.lastError) { $("msg").textContent = chrome.runtime.lastError.message; $("msg").className = "bad"; return; }
    $("msg").textContent = r && r.ok ? "run started; watch the collector log" : `failed: ${r && r.error}`;
    $("msg").className = r && r.ok ? "ok" : "bad";
    setTimeout(load, 1500);
  });
}

$("run").addEventListener("click", () => runNow({}));
$("runOne").addEventListener("click", () => {
  const h = $("handle").value.trim().replace(/^@/, "");
  if (!h) { $("msg").textContent = "enter a handle first"; $("msg").className = "warn"; return; }
  runNow({ handles: [h], skipLeaderboard: true });
});
$("enabled").addEventListener("change", (e) => chrome.storage.local.set({ enabled: e.target.checked }));
$("url").addEventListener("change", (e) => chrome.storage.local.set({ collectorUrl: e.target.value.trim() || DEFAULT_BASE }).then(load));

load();
