// pump.fun callout checker (manual capture)
// 1. Open pump.fun/profile/<handle> in your own browser, click Stats, Callouts tab.
// 2. Open DevTools console, paste this whole file, press Enter.
// 3. It scrolls the list to the end, parses every row, prints totals + a CSV,
//    and copies a JSON capture to the clipboard.
// 4. In the repo:  npm run import -- --clipboard
//    (or save it:  pbpaste > data/captures/<handle>.json  then  npm run import data/captures/<handle>.json)

(async () => {
  const SINCE_DAYS = 23; // Oct 12 -> Nov 4. Set to 0 for all callouts.

  const toNum = (s) => {
    if (!s || s === "—" || s === "-") return null;
    const neg = s.trim().startsWith("-");
    const m = s.replace(/[+\-$,\s]/g, "").match(/^([\d.]+)([KM]?)$/i);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (/k/i.test(m[2])) v *= 1e3;
    if (/m/i.test(m[2])) v *= 1e6;
    return neg ? -v : v;
  };

  const rowRe =
    /(\d[\d,]*)\s*tailers\s*·\s*1h\s*([+\-]\$[\d.,]+[KM]?)\s*·\s*1d\s*([+\-]\$[\d.,]+[KM]?)\s*·\s*reached\s*([+\-]\$[\d.,]+[KM]?|—)/i;
  const agoRe = /^(.*?)\s*·?\s*(\d+)\s*([mhd])\s*ago$/i;

  // locate the modal text block containing the callouts list
  const all = [...document.querySelectorAll("div,section")];
  const modal = all.find(
    (el) =>
      el.innerText &&
      el.innerText.includes("Callouts") &&
      /tailers/.test(el.innerText) &&
      el.innerText.length < 20000 &&
      ![...el.children].some((c) => c.innerText && /tailers/.test(c.innerText) && c.innerText.includes("Callouts"))
  );
  if (!modal) return console.error("Open the Stats modal on the Callouts tab first.");

  const scroller =
    [...modal.querySelectorAll("*")]
      .filter((el) => {
        const cs = getComputedStyle(el);
        return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 10;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || modal;

  const rows = new Map();
  const blocks = new Set(); // raw text around every row seen while scrolling (for `npm run import`)
  const harvest = () => {
    const lines = modal.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(rowRe);
      if (!m) continue;
      blocks.add(lines.slice(Math.max(0, i - 6), i + 4).join("\n"));
      // walk back for name + age
      let name = "?", ageDays = null;
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        const a = lines[j].match(agoRe);
        if (a) {
          name = a[1] || (lines[j - 1] || "?");
          const n = parseInt(a[2], 10);
          ageDays = a[3].toLowerCase() === "d" ? n : a[3].toLowerCase() === "h" ? n / 24 : n / 1440;
          break;
        }
      }
      // walk forward for multiplier + MC
      let mult = null, mc = "";
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const x = lines[j].match(/^(\d+)x$/);
        if (x) mult = parseInt(x[1], 10);
        if (/MC$/.test(lines[j])) mc = lines[j];
      }
      const key = `${name}|${ageDays}|${mult}|${m[1]}`;
      rows.set(key, {
        name,
        ageDays,
        tailers: parseInt(m[1].replace(/,/g, ""), 10),
        pnl1h: toNum(m[2]),
        pnl1d: toNum(m[3]),
        peak: toNum(m[4]),
        mult,
        mc,
      });
    }
  };

  // scroll until no new rows appear
  let stable = 0, last = -1;
  for (let k = 0; k < 400 && stable < 4; k++) {
    harvest();
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 350));
    if (rows.size === last) stable++; else { stable = 0; last = rows.size; }
  }
  harvest();

  const data = [...rows.values()].filter((r) => !SINCE_DAYS || (r.ageDays !== null && r.ageDays <= SINCE_DAYS));
  const sum = (f) => data.reduce((a, r) => a + (r[f] || 0), 0);
  const withPeak = data.filter((r) => r.peak !== null);

  console.table(data);
  console.log({
    handle: location.pathname.split("/").pop(),
    callouts_parsed: data.length,
    callouts_with_peak: withPeak.length,
    tailers_total: sum("tailers"),
    pnl_1h_total: sum("pnl1h"),
    pnl_1d_total: sum("pnl1d"),
    peak_total: sum("peak"),
    peak_median: withPeak.length ? withPeak.map((r) => r.peak).sort((a, b) => a - b)[Math.floor(withPeak.length / 2)] : null,
    since_days: SINCE_DAYS,
  });

  const csv = ["name,age_days,tailers,pnl_1h,pnl_1d,peak,multiplier,mc"]
    .concat(data.map((r) => [r.name, r.ageDays, r.tailers, r.pnl1h, r.pnl1d, r.peak, r.mult, `"${r.mc}"`].join(",")))
    .join("\n");
  console.log(csv);

  // JSON capture for `npm run import`: raw text only, the importer re-parses it with the shared parser.
  const dialog = modal.closest('[role="dialog"]') || modal;
  const og = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute("content") ?? null;
  const capture = {
    version: 1,
    handle: location.pathname.split("/").pop(),
    url: location.href,
    scrapedAt: new Date().toISOString(),
    displayName: document.querySelector("h1")?.innerText?.trim() || og("og:title"),
    avatarUrl: og("og:image"),
    dialogText: dialog.innerText,
    modalText: modal.innerText,
    blocks: [...blocks],
  };
  const json = JSON.stringify(capture);
  // If `npm run collector` is running on this machine, hand the capture over directly.
  const COLLECTOR = "http://127.0.0.1:47831/capture";
  try {
    const res = await fetch(COLLECTOR, { method: "POST", headers: { "content-type": "application/json" }, body: json });
    const out = await res.json();
    if (res.ok) { console.log("capture stored by the local collector:", out); return; }
    console.warn("collector rejected the capture:", out);
  } catch (e) {
    console.log("local collector not reachable (that is fine); falling back to the clipboard");
  }
  try { await navigator.clipboard.writeText(json); console.log(`JSON capture copied to clipboard (${rows.size} rows, ${json.length} chars). Next: npm run import -- --clipboard`); }
  catch (e) { console.log("clipboard blocked; copy this:"); console.log(json); }
})();
