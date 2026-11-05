import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { toNum } from "../parser";
import { normalizeHandle, RAW_DIR } from "../config";
import { log, sleep } from "../log";
import { clickFirst, dismissOnboarding, waitForHuman } from "./browser";

export interface LeaderboardEntry {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  rank: number | null;
  rewards: number | null;
  unit: string | null;
  raw: string;
  view: string;
}

const VIEW_LABELS: Record<string, RegExp> = {
  all: /^\s*all[\s-]?time\s*$|^\s*all\s*$/i,
  monthly: /^\s*(monthly|month|30\s*d(ays)?)\s*$/i,
  weekly: /^\s*(weekly|week|7\s*d(ays)?)\s*$/i,
  daily: /^\s*(daily|day|today|24\s*h)\s*$/i,
};

interface RawEntry { href: string; text: string; anchorText: string; img: string | null }

/** Pull every /profile/ link on the page with the text of its row. */
async function collectRows(page: Page): Promise<RawEntry[]> {
  return page.evaluate(() => {
    const amount = /(\$\s?[\d.,]+\s*[KMB]?)|(\b[\d.,]+\s*SOL\b)/i;
    const out: { href: string; text: string; anchorText: string; img: string | null }[] = [];
    const anchors = [...document.querySelectorAll('a[href*="/profile/"]')] as HTMLAnchorElement[];
    for (const a of anchors) {
      let row: HTMLElement = a;
      for (let i = 0; i < 8 && row.parentElement; i++) {
        const t = row.innerText || "";
        const links = row.querySelectorAll('a[href*="/profile/"]').length;
        if (amount.test(t) && links <= 1) break;
        if (links > 1) { row = a; break; } // climbed into a container holding many rows; give up on climbing
        row = row.parentElement;
      }
      const img = (row.querySelector("img") as HTMLImageElement | null)?.src ?? (a.querySelector("img") as HTMLImageElement | null)?.src ?? null;
      out.push({ href: a.getAttribute("href") || "", text: (row.innerText || "").trim(), anchorText: (a.innerText || "").trim(), img });
    }
    return out;
  });
}

function parseEntry(r: RawEntry, view: string): LeaderboardEntry | null {
  const m = r.href.match(/\/profile\/([^/?#]+)/);
  if (!m) return null;
  const handle = normalizeHandle(decodeURIComponent(m[1]));
  const text = r.text.replace(/\s+/g, " ");
  const rankM = text.match(/(?:^|\s)#?(\d{1,4})(?=\s)/);
  const usd = text.match(/[+\-]?\$\s?[\d.,]+\s*[KMB]?/i);
  const sol = text.match(/([\d.,]+\s*[KMB]?)\s*SOL\b/i);
  let rewards: number | null = null, unit: string | null = null;
  if (usd) { rewards = toNum(usd[0].replace(/\s/g, "")); unit = "USD"; }
  else if (sol) { rewards = toNum(sol[1].replace(/\s/g, "")); unit = "SOL"; }
  return {
    handle,
    displayName: r.anchorText && r.anchorText.length < 80 ? r.anchorText : null,
    avatarUrl: r.img,
    rank: rankM ? parseInt(rankM[1], 10) : null,
    rewards,
    unit,
    raw: text.slice(0, 300),
    view,
  };
}

/**
 * Scrape pump.fun/leaderboard, "Top rewards" tab, for each requested view.
 * Returns one entry per (handle, view). Raw page text is saved to data/raw/leaderboard-<view>.txt.
 */
export async function scrapeLeaderboard(page: Page, views: string[], opts: { interactive?: boolean; rawDir?: string | null } = {}): Promise<LeaderboardEntry[]> {
  const rawDir = opts.rawDir === undefined ? RAW_DIR : opts.rawDir;
  await page.goto("https://pump.fun/leaderboard", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForHuman(page, !!opts.interactive);
  await dismissOnboarding(page);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await sleep(800);

  const tabIdx = await clickFirst([
    page.getByRole("tab", { name: /top rewards/i }),
    page.getByRole("button", { name: /top rewards/i }),
    page.getByRole("link", { name: /top rewards/i }),
    page.getByText(/top rewards/i),
  ], 4000);
  if (tabIdx < 0) log.warn("leaderboard: 'Top rewards' tab not found; scraping whatever is shown");
  await sleep(1000);

  const results: LeaderboardEntry[] = [];
  for (const view of views) {
    const label = VIEW_LABELS[view];
    if (label) {
      const idx = await clickFirst([
        page.getByRole("tab", { name: label }),
        page.getByRole("button", { name: label }),
        page.getByRole("option", { name: label }),
        page.getByText(label),
      ], 3000);
      if (idx < 0) {
        // maybe a <select>
        const sel = page.locator("select");
        let done = false;
        if (await sel.count()) {
          const labels = await sel.first().locator("option").allTextContents();
          const i = labels.findIndex((o) => label.test(o));
          if (i >= 0) { await sel.first().selectOption({ index: i }); done = true; }
        }
        if (!done) { log.warn(`leaderboard: view "${view}" control not found; skipping`); continue; }
      }
      await sleep(1500);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    }

    // scroll the page until no new profile links appear
    const seen = new Map<string, RawEntry>();
    let stable = 0, last = -1;
    for (let k = 0; k < 60 && stable < 3; k++) {
      for (const r of await collectRows(page)) seen.set(r.href + "|" + r.text.slice(0, 60), r);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(500);
      if (seen.size === last) stable++; else { stable = 0; last = seen.size; }
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    const entries = [...seen.values()].map((r) => parseEntry(r, view)).filter((e): e is LeaderboardEntry => !!e && !!e.handle);
    // dedupe by handle, keep the one with a reward figure
    const byHandle = new Map<string, LeaderboardEntry>();
    for (const e of entries) {
      const prev = byHandle.get(e.handle);
      if (!prev || (prev.rewards === null && e.rewards !== null)) byHandle.set(e.handle, e);
    }
    const list = [...byHandle.values()];
    log.info(`leaderboard[${view}]: ${list.length} handles (${list.filter((e) => e.rewards !== null).length} with a reward figure)`);
    results.push(...list);

    if (rawDir) {
      fs.mkdirSync(rawDir, { recursive: true });
      const text: string = await page.evaluate(() => document.body.innerText);
      fs.writeFileSync(path.join(rawDir, `leaderboard-${view}.txt`), text);
    }
  }
  return results;
}
