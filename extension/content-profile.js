// Callout Check collector: profile page content script.
//
// Runs on pump.fun/profile/<handle> in this browser's own session, injected by
// background.js. It does what pumpfun_callout_check.js does by hand: open Stats,
// pick the Callouts tab, pick the widest time range, scroll the list to the end,
// and hand the raw text back. No numbers are parsed here; the local collector
// parses with the shared parser.
//
// It clicks only: the "View stats" control, the Callouts tab, a time-range tab
// (All / 1M), a sort control (to pick Recent/Newest) and "load more"-style
// buttons. It never dismisses terms or cookie dialogs and never interacts with
// a verification page.
//
// Real layout seen 2026-11-04 (innerText of the modal, one item per line):
//   Stats / @handle / Callouts Streaks Volume / LAST ROUND TODAY 1W 1M /
//   Callouts / 13 / 7 new · 6 earlier / Tailers / 1,899 / ... / Tail volume / $120K / ...
//   Callouts / Recent /
//   X / · / 19h ago / 1.1x / $152K / $178K MC / 50 tailers · 1h / −$1K / · 1d / — / · reached / +$1K
//   ... / Performance / ... / Updated Nov 4, 2026, 6:57 PM

(async () => {
  const args = window.__ccArgs || {};
  const token = args.token;
  const t0 = Date.now();
  const HARD_LIMIT_MS = 3.5 * 60_000;

  const send = (result) => { try { chrome.runtime.sendMessage({ type: "result", token, result }); } catch (e) { console.error("[cc] sendMessage failed", e); } };
  const progress = (msg) => { try { chrome.runtime.sendMessage({ type: "progress", token, msg }); } catch { /* ignore */ } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el && el.innerText ? el.innerText.trim() : "");
  const bodyText = () => (document.body && document.body.innerText) || "";
  const waitFor = async (fn, timeoutMs, every = 200) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(every);
    }
  };
  const fail = (error, extra = {}) => ({ status: "failed", error, state: "unknown", durationMs: Date.now() - t0, ...extra });

  // First line of a stats row. The values may follow on the same line (older
  // layout) or on the next lines (current layout); the collector's parser folds both.
  const rowStartRe = /^\d[\d,]*\s*tailers?\b/i;
  const countRows = (s) => (s.match(/(^|\n)\s*\d[\d,]*\s*tailers?\b/gi) || []).length;

  const clickables = (root) => [...root.querySelectorAll("button, [role='tab'], [role='button'], a, [role='menuitem'], [role='option']")];
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const clickByText = (root, re) => {
    let el = clickables(root).find((e) => visible(e) && re.test(text(e)));
    if (!el) {
      const leaf = [...root.querySelectorAll("div, span, p, li")].find((e) => e.children.length === 0 && visible(e) && re.test(text(e)));
      if (leaf) el = leaf.closest("button, [role='tab'], [role='button'], a, [role='menuitem'], [role='option']") || leaf;
    }
    if (!el) return false;
    try { el.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
    el.click();
    return true;
  };

  const meta = () => {
    const og = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute("content") ?? null;
    const h1 = text(document.querySelector("h1")) || null;
    let avatar = og("og:image");
    const handle = (args.handle || "").toLowerCase();
    const img = [...document.querySelectorAll("img")].find((i) => {
      const alt = (i.getAttribute("alt") || "").toLowerCase();
      return (handle && alt.includes(handle)) || /avatar|profile/i.test(alt + " " + (i.getAttribute("src") || ""));
    });
    if (img && img.src) avatar = img.src;
    return { displayName: h1 || og("og:title") || document.title || null, avatarUrl: avatar };
  };

  const endpoints = () => {
    try {
      return [...new Set(performance.getEntriesByType("resource")
        .filter((e) => (e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") && /pump/i.test(new URL(e.name).hostname))
        .map((e) => e.name))].slice(0, 100);
    } catch { return []; }
  };

  // Labels of the visible controls on the page, for the failure log.
  const controlLabels = (root) => [...new Set(clickables(root).filter(visible).map((e) => text(e).replace(/\s+/g, " ").slice(0, 30)).filter(Boolean))].slice(0, 40);

  try {
    // 1. page ready
    await waitFor(() => document.readyState === "complete", 30_000);
    await sleep(800);
    const bt = bodyText();
    if (/verify you are human|just a moment|performing security verification/i.test(bt)) return send(fail("verification page shown"));
    if (/profile not found|user not found|page not found/i.test(bt) && !/\bstats\b/i.test(bt)) return send({ status: "notfound", error: "profile not found", state: "unknown", durationMs: Date.now() - t0 });
    const m = meta();

    // 2. Stats (the button reads "View stats" on the current site)
    const statsRe = /^\s*(view\s+)?stats\s*$/i;
    if (!(await waitFor(() => clickables(document).some((e) => visible(e) && statsRe.test(text(e))), 10_000, 300))) {
      const blocked = document.querySelector("[role='dialog'], [aria-modal='true']");
      return send(fail(blocked ? "blocked by a dialog" : "Stats control not found", { ...m, controls: controlLabels(document) }));
    }
    clickByText(document, statsRe);
    await waitFor(() => /tail volume|callouts/i.test(bodyText()), 15_000);
    await sleep(700);
    progress("stats open");

    // 3. Callouts tab inside the dialog
    const dialogs = document.querySelectorAll("[role='dialog']");
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
    if (!clickByText(scope, /^\s*callouts\s*$/i)) progress("Callouts tab not found; assuming selected");
    await sleep(900);

    // 3b. widest time range. pump.fun defaults to "LAST ROUND"; prefer All, then 1M.
    const headerCount = () => { const h = (scope.innerText || "").match(/Callouts\s*\n\s*([\d,]+)/); return h ? h[1] : null; };
    let range = null;
    try {
      const tabs = clickables(scope).filter((e) => visible(e) && text(e).length < 20);
      const pick = tabs.find((e) => /^\s*all([\s-]?time)?\s*$/i.test(text(e))) || tabs.find((e) => /^\s*1\s*M\s*$/i.test(text(e)));
      if (pick) {
        range = text(pick);
        if (pick.getAttribute("aria-selected") !== "true") {
          const before = headerCount();
          pick.click();
          await waitFor(() => headerCount() !== before, 8_000);
          await sleep(1200);
        }
        progress(`range ${range}: ${headerCount() ?? "?"} callouts`);
      } else {
        progress("no time range control; using the default view");
      }
    } catch (e) { progress("range control: " + e.message); }

    // 4. sort: prefer Recent / Newest (best effort)
    try {
      const sel = scope.querySelector("select");
      if (sel) {
        const i = [...sel.options].findIndex((o) => /recent|newest|latest/i.test(o.textContent || ""));
        if (i >= 0 && sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event("change", { bubbles: true })); await sleep(700); }
      } else {
        const sortBtn = clickables(scope).find((e) => visible(e) && /sort|multiplier|recent|newest|latest/i.test(text(e)) && text(e).length < 40);
        if (sortBtn && !/recent|newest|latest/i.test(text(sortBtn))) {
          sortBtn.click();
          await sleep(400);
          clickByText(document, /^\s*(recent|newest|most recent|latest)\s*$/i);
          await sleep(700);
        }
      }
    } catch (e) { progress("sort control: " + e.message); }

    // 5. rows or empty state
    const state = await waitFor(() => {
      const t = bodyText();
      if (/\btailers?\b/i.test(t) && /reached/i.test(t)) return "rows";
      if (/no callouts|nothing to show|no data/i.test(t)) return "empty";
      return null;
    }, 15_000) || "unknown";
    progress("state " + state);

    // 6. list element + scroller (port of the console script)
    const all = [...document.querySelectorAll("div,section")];
    const list = all.find((el) => {
      const t = el.innerText;
      return t && t.includes("Callouts") && /tailers/.test(t) && t.length < 500000 &&
        ![...el.children].some((c) => c.innerText && /tailers/.test(c.innerText) && c.innerText.includes("Callouts"));
    });
    const dialog = (list && list.closest("[role='dialog']")) || (scope !== document ? scope : null) || list || document.body;
    let modalText = "", iterations = 0;
    const blocks = new Set();
    // One block per row: the lines around its "N tailers" line, wide enough to
    // hold name/age/multiplier/MC above it and the values below it in either layout.
    const collect = (src) => {
      const lines = src.split("\n").map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        if (!rowStartRe.test(lines[i])) continue;
        blocks.add(lines.slice(Math.max(0, i - 7), i + 9).join("\n"));
      }
    };

    if (list) {
      const scroller = [...dialog.querySelectorAll("*")]
        .filter((el) => { const cs = getComputedStyle(el); return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 10; })
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || list;
      // 7. scroll until no new rows appear (the list loads more rows on scroll)
      let stable = 0, last = -1;
      for (let k = 0; k < 400 && stable < 6; k++) {
        iterations = k + 1;
        collect(list.innerText);
        scroller.scrollTop = scroller.scrollHeight;
        const more = clickables(dialog).find((e) => visible(e) && /load more|show more|see more/i.test(text(e)));
        if (more) more.click();
        await sleep(600);
        if (blocks.size === last) stable++; else { stable = 0; last = blocks.size; }
        if (k % 20 === 19) progress(`scroll ${k + 1}, ${blocks.size} rows`);
        if (Date.now() - t0 > HARD_LIMIT_MS) { progress("time limit reached; stopping scroll"); break; }
      }
      collect(list.innerText);
      modalText = list.innerText;
    } else {
      modalText = dialog.innerText || "";
      collect(modalText);
    }
    const dialogText = dialog.innerText || "";

    // 8. report; close the modal
    const result = {
      status: "ok",
      state,
      range,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      modalText,
      blocks: [...blocks],
      dialogText,
      rowsSeen: countRows(modalText),
      iterations,
      durationMs: Date.now() - t0,
      endpoints: endpoints(),
    };
    try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch { /* ignore */ }
    send(result);
  } catch (e) {
    send(fail(`content script error: ${e && e.message ? e.message : String(e)}`));
  }
})();
