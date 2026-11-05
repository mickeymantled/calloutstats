import fs from "node:fs";
import path from "node:path";
import type { Page, JSHandle } from "playwright";
import { harvest, splitLines, parseHeaderTotals, type ParsedRow, type HeaderTotals } from "../parser";
import { profileUrl, RAW_DIR } from "../config";
import { log, sleep } from "../log";
import { clickFirst, visibleSoon, dismissOnboarding, waitForHuman } from "./browser";

export class ProfileNotFoundError extends Error {}
export class ParseFailure extends Error {}

export interface ProfileScrape {
  handle: string;
  url: string;
  rows: ParsedRow[];
  header: HeaderTotals;
  displayName: string | null;
  avatarUrl: string | null;
  /** innerText of the stats dialog after scrolling */
  rawText: string;
  iterations: number;
  zeroCallouts: boolean;
  scrapedAt: string;
}

interface ModalParts { modal: HTMLElement; dialog: HTMLElement; scroller: HTMLElement }

export interface ScrapeProfileOptions {
  debug?: boolean;
  interactive?: boolean;
  now?: Date;
  /** directory for raw text / screenshots; null disables */
  rawDir?: string | null;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Open pump.fun/profile/<handle>, Stats -> Callouts, scroll until no new rows
 * appear, parse every row. The modal/scroller locator and the scroll loop are
 * ported from pumpfun_callout_check.js.
 */
export async function scrapeProfile(page: Page, handle: string, opts: ScrapeProfileOptions = {}): Promise<ProfileScrape> {
  const now = opts.now ?? new Date();
  const rawDir = opts.rawDir === undefined ? RAW_DIR : opts.rawDir;
  const url = profileUrl(handle);
  const dbg = async (name: string) => {
    if (!opts.debug || !rawDir) return;
    fs.mkdirSync(rawDir, { recursive: true });
    await page.screenshot({ path: path.join(rawDir, `${safe(handle)}.${name}.png`), fullPage: false }).catch(() => {});
  };

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForHuman(page, !!opts.interactive);
  await dismissOnboarding(page);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await sleep(800);
  await dbg("1-profile");

  const bodyText: string = await page.evaluate(() => document.body.innerText);
  if (/profile not found|user not found|page not found|could ?n.t find|doesn.t exist/i.test(bodyText) && !/\bstats\b/i.test(bodyText)) {
    throw new ProfileNotFoundError(`profile "${handle}" not found`);
  }

  const meta = await page.evaluate((h) => {
    const og = (p: string) => document.querySelector(`meta[property="${p}"]`)?.getAttribute("content") ?? null;
    const h1 = (document.querySelector("h1") as HTMLElement | null)?.innerText?.trim() ?? null;
    let avatar: string | null = og("og:image");
    const img = [...document.querySelectorAll("img")].find((i) => {
      const alt = (i.getAttribute("alt") || "").toLowerCase();
      return alt.includes(h.toLowerCase()) || /avatar|profile/i.test(alt + " " + (i.getAttribute("src") || ""));
    });
    if (img?.src) avatar = img.src;
    return { title: og("og:title") ?? document.title ?? null, h1, avatar };
  }, handle);

  // --- open Stats ---
  const statsIdx = await clickFirst([
    page.getByRole("button", { name: /^\s*stats\s*$/i }),
    page.getByRole("tab", { name: /^\s*stats\s*$/i }),
    page.getByRole("link", { name: /^\s*stats\s*$/i }),
    page.getByText(/^\s*stats\s*$/i),
  ], 4000);
  if (statsIdx < 0) throw new ParseFailure("Stats control not found on profile page");
  await page.waitForFunction(() => /tail volume|callouts/i.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
  await sleep(700);
  await dbg("2-stats");

  const dialog = page.locator('[role="dialog"]').last();
  const scope = (await visibleSoon(dialog, 2500)) ? dialog : page;

  // --- Callouts tab ---
  const tabIdx = await clickFirst([
    scope.getByRole("tab", { name: /^\s*callouts\s*$/i }),
    scope.getByRole("button", { name: /^\s*callouts\s*$/i }),
    scope.getByText(/^\s*callouts\s*$/i),
  ], 4000);
  if (tabIdx < 0) log.warn(`${handle}: Callouts tab not found; assuming it is already selected`);
  await sleep(900);

  // --- sort by newest when the option exists (best effort) ---
  try {
    const sortBtn = scope.getByRole("button", { name: /sort|newest|oldest|recent|latest/i });
    if (await visibleSoon(sortBtn, 1200)) {
      const label = (await sortBtn.first().innerText().catch(() => "")).trim();
      if (!/newest|recent|latest/i.test(label)) {
        await sortBtn.first().click();
        await clickFirst([
          page.getByRole("option", { name: /newest|most recent|latest/i }),
          page.getByRole("menuitem", { name: /newest|most recent|latest/i }),
          page.getByText(/^\s*(newest|most recent|latest)\s*$/i),
        ], 1500);
        await sleep(700);
      }
    } else {
      const sel = scope.locator("select");
      if (await visibleSoon(sel, 500)) {
        const labels = await sel.first().locator("option").allTextContents();
        const i = labels.findIndex((o) => /newest|recent|latest/i.test(o));
        if (i >= 0) { await sel.first().selectOption({ index: i }); await sleep(700); }
      }
    }
  } catch (e) {
    log.debug("sort control", String(e));
  }

  // --- wait for rows or an empty state ---
  const state = await page.waitForFunction(() => {
    const t = document.body.innerText;
    if (/\btailers?\b/i.test(t) && /reached/i.test(t)) return "rows";
    if (/no callouts|hasn.t (made|posted) any callouts|nothing to show|no data/i.test(t)) return "empty";
    return null;
  }, null, { timeout: 15_000 }).then((h) => h.jsonValue() as Promise<"rows" | "empty">).catch(() => null);
  await dbg("3-callouts");

  // --- modal + scroller (port of the console script) ---
  const parts = await page.evaluateHandle(() => {
    const all = [...document.querySelectorAll("div,section")] as HTMLElement[];
    const modal = all.find(
      (el) =>
        el.innerText &&
        el.innerText.includes("Callouts") &&
        /tailers/.test(el.innerText) &&
        el.innerText.length < 500000 &&
        ![...el.children].some((c) => (c as HTMLElement).innerText && /tailers/.test((c as HTMLElement).innerText) && (c as HTMLElement).innerText.includes("Callouts")),
    );
    if (!modal) return null;
    const dialog = (modal.closest('[role="dialog"]') as HTMLElement | null) ?? modal;
    const scroller =
      ([...dialog.querySelectorAll("*")] as HTMLElement[])
        .filter((el) => {
          const cs = getComputedStyle(el);
          return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 10;
        })
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || modal;
    return { modal, dialog, scroller };
  }) as JSHandle<ModalParts | null>;

  const rows = new Map<string, ParsedRow>();
  let iterations = 0;
  let rawText = "";

  const found = await parts.evaluate((o) => o !== null).catch(() => false);
  if (found) {
    const h = parts as JSHandle<ModalParts>;
    // scroll until no new rows appear (port)
    let stable = 0, last = -1;
    for (let k = 0; k < 400 && stable < 4; k++) {
      iterations = k + 1;
      const text: string = await h.evaluate((o) => o.modal.innerText);
      harvest(splitLines(text), rows, now);
      await h.evaluate((o) => { o.scroller.scrollTop = o.scroller.scrollHeight; });
      const more = scope.getByRole("button", { name: /load more|show more|see more/i });
      if (await more.first().isVisible().catch(() => false)) await more.first().click().catch(() => {});
      await sleep(350);
      if (rows.size === last) stable++; else { stable = 0; last = rows.size; }
    }
    harvest(splitLines(await h.evaluate((o) => o.modal.innerText)), rows, now);
    rawText = await h.evaluate((o) => o.dialog.innerText);
  } else {
    // no element matched: fall back to the dialog / body text so we still capture header + state
    rawText = scope === page ? bodyText : await dialog.innerText().catch(() => bodyText);
    harvest(splitLines(rawText), rows, now);
  }
  await dbg("4-scrolled");

  const header = parseHeaderTotals(splitLines(rawText));
  if (rawDir) {
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, `${safe(handle)}.txt`), rawText);
  }

  await page.keyboard.press("Escape").catch(() => {});

  const list = [...rows.values()];
  const zeroCallouts = list.length === 0 && (state === "empty" || header.callouts === 0);
  if (list.length === 0 && !zeroCallouts) {
    throw new ParseFailure(`no callout rows parsed for ${handle} (state=${state ?? "unknown"}, header callouts=${header.callouts ?? "?"})`);
  }
  if (header.callouts !== null && list.length < header.callouts) {
    log.warn(`${handle}: parsed ${list.length} rows but header says ${header.callouts} callouts (list may be capped by pump.fun or still loading)`);
  }

  return {
    handle,
    url,
    rows: list,
    header,
    displayName: meta.h1 || meta.title,
    avatarUrl: meta.avatar,
    rawText,
    iterations,
    zeroCallouts,
    scrapedAt: now.toISOString(),
  };
}
