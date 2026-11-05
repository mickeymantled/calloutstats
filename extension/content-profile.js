// Callout Check collector: profile page content script.
//
// Runs on pump.fun/profile/<handle> in this browser's own session, injected by
// background.js. It does what pumpfun_callout_check.js does by hand: open Stats,
// pick the Callouts tab, scroll the list to the end, and hand the raw text back.
// No numbers are parsed here; the local collector parses with the shared parser.
//
// It clicks only: the Stats control, the Callouts tab, a sort control (to pick
// Recent/Newest) and "load more"-style buttons. It never dismisses terms or
// cookie dialogs and never interacts with a verification page.

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

  // Same row shape the parser matches (docs/collector-protocol.md).
  const rowRe = /(\d[\d,]*)\s*tailers?\s*[·•]\s*1h\s*[+\-]?\$[\d.,]+[KMB]?\s*[·•]\s*1d\s*[+\-]?\$[\d.,]+[KMB]?\s*[·•]\s*reached\s*([+\-]?\$[\d.,]+[KMB]?|—|-)/i;

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

  try {
    // 1. page ready
    await waitFor(() => document.readyState === "complete", 30_000);
    await sleep(800);
    const bt = bodyText();
    if (/verify you are human|just a moment|performing security verification/i.test(bt)) return send(fail("verification page shown"));
    if (/profile not found|user not found|page not found/i.test(bt) && !/\bstats\b/i.test(bt)) return send({ status: "notfound", error: "profile not found", state: "unknown", durationMs: Date.now() - t0 });
    const m = meta();

    // 2. Stats
    if (!clickByText(document, /^\s*stats\s*$/i)) {
      const blocked = document.querySelector("[role='dialog'], [aria-modal='true']");
      return send(fail(blocked ? "blocked by a dialog" : "Stats control not found", m));
    }
    await waitFor(() => /tail volume|callouts/i.test(bodyText()), 15_000);
    await sleep(700);
    progress("stats open");

    // 3. Callouts tab inside the dialog
    const dialogs = document.querySelectorAll("[role='dialog']");
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
    if (!clickByText(scope, /^\s*callouts\s*$/i)) progress("Callouts tab not found; assuming selected");
    await sleep(900);

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
    const collect = (src) => {
      const lines = src.split("\n").map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        if (!rowRe.test(lines[i])) continue;
        blocks.add(lines.slice(Math.max(0, i - 6), i + 4).join("\n"));
      }
    };

    if (list) {
      const scroller = [...dialog.querySelectorAll("*")]
        .filter((el) => { const cs = getComputedStyle(el); return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 10; })
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || list;
      // 7. scroll until no new rows appear
      let stable = 0, last = -1;
      for (let k = 0; k < 400 && stable < 4; k++) {
        iterations = k + 1;
        collect(list.innerText);
        scroller.scrollTop = scroller.scrollHeight;
        const more = clickables(dialog).find((e) => visible(e) && /load more|show more|see more/i.test(text(e)));
        if (more) more.click();
        await sleep(350);
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
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      modalText,
      blocks: [...blocks],
      dialogText,
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
