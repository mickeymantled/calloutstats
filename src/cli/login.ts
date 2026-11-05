import fs from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { loadConfig, ensureDirs, fromRoot } from "../config";
import { loginMarkerPath, promptEnter } from "../scraper/browser";

/**
 * npm run login
 *
 * Opens the scraper's browser profile as a plain, NON-automated browser window
 * (no Playwright attached). pump.fun's Cloudflare check keeps re-challenging a
 * window that is being driven by automation, so the one-time verification and
 * login happen here, as a normal user would do them. Cookies land in
 * userDataDir and the automated scraper reuses that profile afterwards.
 *
 * Close the window when you are done (or press Enter here).
 */
function executableFor(channel: string | null): string {
  if (!channel) return chromium.executablePath();
  const known: Record<string, string> = {
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "chrome-beta": "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "chrome-canary": "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  };
  const p = known[channel];
  if (!p || !fs.existsSync(p)) throw new Error(`browser channel "${channel}" is not installed at ${p ?? "(unknown path)"}`);
  return p;
}

(async () => {
  const cfg = loadConfig();
  ensureDirs();
  const userDataDir = fromRoot(cfg.browser.userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const exe = executableFor(cfg.browser.channel);

  const child = spawn(exe, [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://pump.fun/",
  ], { stdio: "ignore" });

  console.log(`Opened ${exe.split("/").pop()} on pump.fun with profile ${cfg.browser.userDataDir}`);
  console.log("1. Complete the verification check in that window.");
  console.log("2. Log in if you want the session saved.");
  console.log("3. Close the window (or press Enter here).");

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const pressed = promptEnter("Press Enter when done... ").then(() => "enter" as const);
  const winner = await Promise.race([exited.then(() => "exit" as const), pressed]);
  if (winner === "enter" && child.exitCode === null) {
    child.kill("SIGTERM"); // graceful: Chrome flushes cookies on SIGTERM
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  fs.writeFileSync(loginMarkerPath(cfg), new Date().toISOString());
  console.log("Session saved. Next: npm run verify mickeymantled");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
