import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium, type BrowserContext, type Page, type Locator } from "playwright";
import { fromRoot, RAW_DIR, type Config } from "../config";
import { log, sleep } from "../log";

export const LOGIN_MARKER = ".callout-check-login-done";

/**
 * Headed Chromium with a persistent profile. The user logs in / completes the
 * Cloudflare interstitial by hand once in this window; cookies persist in
 * userDataDir so later runs reuse the session.
 */
export async function launchContext(cfg: Config): Promise<BrowserContext> {
  const userDataDir = fromRoot(cfg.browser.userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: cfg.browser.headless,
    channel: cfg.browser.channel ?? undefined,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: cfg.browser.timezoneId,
  });
  ctx.setDefaultTimeout(20_000);
  return ctx;
}

export function loginMarkerPath(cfg: Config) {
  return path.join(fromRoot(cfg.browser.userDataDir), LOGIN_MARKER);
}

/** True when the page is showing a Cloudflare interstitial that a human has to complete. */
export async function needsHuman(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const t = document.title || "";
      const b = document.body?.innerText || "";
      return /just a moment|attention required|checking your browser|verify you are human/i.test(t + "\n" + b);
    });
  } catch {
    return false;
  }
}

export class HumanNeededError extends Error {}

/**
 * If a Cloudflare interstitial is up: in interactive mode, wait for the user to
 * complete it in the browser window; otherwise fail fast with instructions.
 */
export async function waitForHuman(page: Page, interactive: boolean, maxMs = 10 * 60_000, selfResolveMs = 45_000): Promise<void> {
  if (!(await needsHuman(page))) return;
  const start = Date.now();
  log.info("pump.fun is showing its verification page; giving it up to 45s to finish on its own...");
  let announced = false;
  while (await needsHuman(page)) {
    const elapsed = Date.now() - start;
    if (elapsed > selfResolveMs) {
      if (!interactive) {
        await saveVerificationSnapshot(page);
        throw new HumanNeededError("pump.fun is showing a verification page. Run `npm run login` in a terminal and complete it in the browser window, then retry.");
      }
      if (!announced) {
        log.warn("The verification page did not clear by itself. Please complete it in the browser window; waiting...");
        announced = true;
      }
      if (elapsed > maxMs) throw new HumanNeededError("Verification page was not completed in time");
    }
    await sleep(1000);
  }
  log.info(`Verification page cleared after ${Math.round((Date.now() - start) / 1000)}s`);
}

/** Debug aid: screenshot + text of the verification page so a failed unattended run can be diagnosed. */
async function saveVerificationSnapshot(page: Page): Promise<void> {
  try {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: path.join(RAW_DIR, `verification-${ts}.png`) }).catch(() => {});
    const info = await page.evaluate(() => ({ url: location.href, title: document.title, text: (document.body?.innerText || "").slice(0, 3000) }));
    fs.writeFileSync(path.join(RAW_DIR, `verification-${ts}.txt`), `${info.url}\n${info.title}\n\n${info.text}`);
    log.info(`saved verification page snapshot to data/raw/verification-${ts}.{png,txt}`);
  } catch { /* best effort */ }
}

/** Best-effort dismissal of pump.fun's first-visit onboarding modal. */
export async function dismissOnboarding(page: Page): Promise<void> {
  const candidates = [
    page.getByRole("button", { name: /ready to pump/i }),
    page.getByRole("button", { name: /^i('|’)m ready/i }),
  ];
  for (const c of candidates) {
    if (await visibleSoon(c, 800)) {
      await c.first().click().catch(() => {});
      await sleep(400);
      return;
    }
  }
}

export async function visibleSoon(loc: Locator, timeout = 1500): Promise<boolean> {
  return loc.first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
}

/** Click the first locator that becomes visible. Returns which index was clicked, or -1. */
export async function clickFirst(locs: Locator[], timeout = 2500): Promise<number> {
  for (let i = 0; i < locs.length; i++) {
    if (await visibleSoon(locs[i], timeout)) {
      await locs[i].first().click({ timeout: 5000 });
      return i;
    }
  }
  return -1;
}

export async function promptEnter(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.question(message, () => resolve()));
  rl.close();
  return true;
}

/**
 * Open pump.fun and, on the first interactive run, give the user a chance to log
 * in (the session persists in userDataDir). Non-interactive runs never block on stdin.
 */
export async function ensureSession(page: Page, cfg: Config, interactive: boolean): Promise<void> {
  await page.goto("https://pump.fun/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForHuman(page, interactive);
  await dismissOnboarding(page);
  const marker = loginMarkerPath(cfg);
  if (fs.existsSync(marker)) return;
  if (interactive) {
    log.info("First run: a browser window is open on pump.fun.");
    const answered = await promptEnter("Log in to pump.fun in that window if you want the session saved (optional), then press Enter here to continue... ");
    if (answered) fs.writeFileSync(marker, new Date().toISOString());
  } else {
    log.warn("No saved login marker and not running interactively; continuing without login. Run `npm run login` once to save a session.");
  }
}
