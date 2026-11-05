import { runScrape } from "../scraper/run";

// npm run scrape [-- --handle a,b] [--skip-leaderboard] [--limit N] [--debug] [--no-interactive]
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const handlesArg = val("handle") ?? val("handles");
runScrape({
  handles: handlesArg ? handlesArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  skipLeaderboard: flag("skip-leaderboard"),
  limit: val("limit") ? parseInt(val("limit")!, 10) : undefined,
  debug: flag("debug"),
  interactive: !flag("no-interactive") && !!process.stdin.isTTY,
}).then((s) => {
  process.exit(s.status === "failed" ? 2 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
