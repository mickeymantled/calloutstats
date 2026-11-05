import { createCollector } from "../collector/server";
import { ensureDirs } from "../config";
import { log } from "../log";

// npm run collector [-- --port N] [--debug]
//
// Starts the local collector service (docs/collector-protocol.md) and keeps it
// running until SIGINT/SIGTERM. launchd/com.calloutcheck.collector.plist runs this
// at login with KeepAlive.
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

if (flag("debug")) process.env.DEBUG = process.env.DEBUG || "1";
const portArg = val("port");
const port = portArg ? parseInt(portArg, 10) : undefined;
if (portArg && (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535)) {
  console.error(`bad --port value: ${portArg}`);
  process.exit(2);
}

ensureDirs();
const collector = createCollector(port !== undefined ? { port } : {});

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`collector: ${signal} received, shutting down`);
  const timer = setTimeout(() => { log.warn("collector: shutdown timed out, exiting"); process.exit(1); }, 5000);
  collector.stop().then(() => { clearTimeout(timer); process.exit(0); });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

collector.start().then(({ url }) => {
  console.log(`collector listening on ${url}`);
  console.log(`  status:   curl ${url}/status`);
  console.log(`  request:  npm run scrape:request -- [--handle a,b] [--skip-leaderboard] [--limit N]`);
}).catch((e: NodeJS.ErrnoException) => {
  if (e?.code === "EADDRINUSE") console.error(`collector: port already in use (${e.message}). Is another collector running? Check: launchctl print gui/$(id -u)/com.calloutcheck.collector`);
  else console.error(`collector: failed to start: ${e?.stack ?? String(e)}`);
  process.exit(1);
});
