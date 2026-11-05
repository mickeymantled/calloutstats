// Callout Check collector: leaderboard content script.
//
// Runs on pump.fun/leaderboard, injected by background.js. Opens the "Top
// rewards" tab, then for each requested view (all time, monthly, ...) scrolls
// until no new profile links appear and reports one entry per profile link:
// handle, display text, avatar, rank, the reward figure as shown, and the row
// text. Parsing of amounts is kept minimal; the raw row text travels too.

(async () => {
  const args = window.__ccArgs || {};
  const token = args.token;
  const views = Array.isArray(args.views) && args.views.length ? args.views : ["all", "monthly"];
  const t0 = Date.now();

  const send = (result) => { try { chrome.runtime.sendMessage({ type: "result", token, result }); } catch (e) { console.error("[cc] sendMessage failed", e); } };
  const progress = (msg) => { try { chrome.runtime.sendMessage({ type: "progress", token, msg }); } catch { /* ignore */ } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el && el.innerText ? el.innerText.trim() : "");
  const bodyText = () => (document.body && document.body.innerText) || "";
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const clickables = (root) => [...root.querySelectorAll("button, [role='tab'], [role='button'], a, [role='option'], [role='menuitem']")];
  const clickByText = (root, re) => {
    let el = clickables(root).find((e) => visible(e) && re.test(text(e)) && text(e).length < 40);
    if (!el) {
      const leaf = [...root.querySelectorAll("div, span, p, li")].find((e) => e.children.length === 0 && visible(e) && re.test(text(e)));
      if (leaf) el = leaf.closest("button, [role='tab'], [role='button'], a, [role='option']") || leaf;
    }
    if (!el) return false;
    try { el.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
    el.click();
    return true;
  };

  const VIEW_LABELS = {
    all: /^\s*all[\s-]?time\s*$|^\s*all\s*$/i,
    monthly: /^\s*(monthly|month|30\s*d(ays)?)\s*$/i,
    weekly: /^\s*(weekly|week|7\s*d(ays)?)\s*$/i,
    daily: /^\s*(daily|day|today|24\s*h)\s*$/i,
  };

  const amountRe = /(\$\s?[\d.,]+\s*[KMB]?)|(\b[\d.,]+\s*[KMB]?\s*SOL\b)/i;

  const collectRows = () => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/profile/"]')) {
      let row = a;
      for (let i = 0; i < 8 && row.parentElement; i++) {
        const t = row.innerText || "";
        const links = row.querySelectorAll('a[href*="/profile/"]').length;
        if (amountRe.test(t) && links <= 1) break;
        if (links > 1) { row = a; break; }
        row = row.parentElement;
      }
      const img = row.querySelector("img") || a.querySelector("img");
      const rowText = (row.innerText || "").replace(/\s+/g, " ").trim();
      const href = a.getAttribute("href") || "";
      const hm = href.match(/\/profile\/([^/?#]+)/);
      if (!hm) continue;
      let handle = hm[1];
      try { handle = decodeURIComponent(handle); } catch { /* keep raw */ }
      const rankM = rowText.match(/(?:^|\s)#?(\d{1,4})(?=\s)/);
      const usd = rowText.match(/[+\-]?\$\s?[\d.,]+\s*[KMB]?/i);
      const sol = rowText.match(/([\d.,]+\s*[KMB]?)\s*SOL\b/i);
      out.push({
        handle,
        displayName: text(a) && text(a).length < 80 ? text(a) : null,
        avatarUrl: img && img.src ? img.src : null,
        rank: rankM ? parseInt(rankM[1], 10) : null,
        rewardsText: usd ? usd[0].replace(/\s/g, "") : sol ? sol[0].replace(/\s+/g, " ") : null,
        unit: usd ? "USD" : sol ? "SOL" : null,
        raw: rowText.slice(0, 300),
      });
    }
    return out;
  };

  try {
    await new Promise((r) => { if (document.readyState === "complete") r(); else window.addEventListener("load", r, { once: true }); });
    await sleep(800);
    if (/verify you are human|just a moment|performing security verification/i.test(bodyText())) return send({ ok: false, error: "verification page shown", views: [] });

    if (!clickByText(document, /top rewards/i)) progress("'Top rewards' tab not found; collecting what is shown");
    await sleep(1000);

    const results = [];
    for (const view of views) {
      const label = VIEW_LABELS[view];
      if (label) {
        let picked = clickByText(document, label);
        if (!picked) {
          const sel = document.querySelector("select");
          if (sel) {
            const i = [...sel.options].findIndex((o) => label.test(o.textContent || ""));
            if (i >= 0) { sel.selectedIndex = i; sel.dispatchEvent(new Event("change", { bubbles: true })); picked = true; }
          }
        }
        if (!picked) { progress(`view "${view}" control not found; skipping`); continue; }
        await sleep(1500);
      }
      // scroll until the number of profile links stops growing
      const seen = new Map();
      let stable = 0, last = -1;
      for (let k = 0; k < 60 && stable < 3; k++) {
        for (const r of collectRows()) seen.set(r.handle + "|" + r.raw.slice(0, 60), r);
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(500);
        if (seen.size === last) stable++; else { stable = 0; last = seen.size; }
        if (Date.now() - t0 > 4.5 * 60_000) break;
      }
      window.scrollTo(0, 0);
      // one entry per handle, prefer the one with a reward figure
      const byHandle = new Map();
      for (const e of seen.values()) {
        const prev = byHandle.get(e.handle);
        if (!prev || (!prev.rewardsText && e.rewardsText)) byHandle.set(e.handle, e);
      }
      const entries = [...byHandle.values()].map((e) => ({
        handle: e.handle,
        displayName: e.displayName,
        avatarUrl: e.avatarUrl,
        rank: e.rank,
        rewards: null, // the collector parses rewardsText with its own number parser
        rewardsText: e.rewardsText,
        unit: e.unit,
        raw: e.raw,
      }));
      results.push({ view, entries, rawText: bodyText().slice(0, 200_000) });
      progress(`view ${view}: ${entries.length} entries`);
    }
    send({ ok: true, views: results, durationMs: Date.now() - t0 });
  } catch (e) {
    send({ ok: false, error: `content script error: ${e && e.message ? e.message : String(e)}`, views: [] });
  }
})();
