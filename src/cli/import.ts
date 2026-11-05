import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig, ensureDirs, normalizeHandle, profileUrl, RAW_DIR } from "../config";
import { log } from "../log";
import { harvest, splitLines, parseHeaderTotals, type ParsedRow } from "../parser";
import { openDb, startRun, finishRun, upsertKol, storeProfileResult, insertProfileSnapshot } from "../db";
import { exportBundle } from "../export";
import { dropCutDuplicates } from "../collector/server";

/**
 * npm run import <capture.json> [more.json ...]   |   npm run import -- --clipboard
 *
 * Imports captures made by hand with pumpfun_callout_check.js (paste it into the
 * DevTools console on pump.fun/profile/<handle> with the Stats > Callouts modal
 * open; it copies a JSON capture to the clipboard). Each capture is parsed with
 * the same parser the scraper uses and stored as one run, then the site bundle
 * is re-exported. Nothing here talks to pump.fun.
 *
 * Capture shape (version 1):
 *   { "version": 1, "handle": "mickeymantled", "url": "...", "scrapedAt": "ISO",
 *     "displayName": "...", "avatarUrl": "...", "dialogText": "...", "modalText": "...",
 *     "blocks": ["...", ...] }
 */
interface Capture {
  version?: number;
  handle: string;
  url?: string;
  scrapedAt?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  dialogText?: string;
  modalText?: string;
  blocks?: string[];
}

const args = process.argv.slice(2);
const useClipboard = args.includes("--clipboard");
const files = args.filter((a) => !a.startsWith("--"));
if (!useClipboard && files.length === 0) {
  console.error("usage: npm run import <capture.json> [more.json ...]   or   npm run import -- --clipboard");
  process.exit(1);
}

function readCaptures(): { name: string; capture: Capture }[] {
  const out: { name: string; capture: Capture }[] = [];
  if (useClipboard) {
    const text = execSync("pbpaste", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    out.push({ name: "clipboard", capture: parseCapture(text, "clipboard") });
  }
  for (const f of files) out.push({ name: f, capture: parseCapture(fs.readFileSync(f, "utf8"), f) });
  return out;
}

function parseCapture(text: string, name: string): Capture {
  let c: Capture;
  try { c = JSON.parse(text); } catch (e) { throw new Error(`${name}: not JSON (${String(e)}). Did you copy the capture from the console script?`); }
  if (!c || typeof c !== "object" || !c.handle) throw new Error(`${name}: capture has no "handle"`);
  if (!c.modalText && !(c.blocks && c.blocks.length)) throw new Error(`${name}: capture has no modalText or blocks`);
  return c;
}

function parseRowsFromCapture(c: Capture, scrapedAt: Date): ParsedRow[] {
  const rows = new Map<string, ParsedRow>();
  if (c.modalText) harvest(splitLines(c.modalText), rows, scrapedAt);
  for (const b of c.blocks ?? []) harvest(splitLines(b), rows, scrapedAt);
  // a block can cut the previous row's name line, which harvest() keys as "?"; drop those twins
  return dropCutDuplicates([...rows.values()]);
}

const cfg = loadConfig();
ensureDirs();
const db = openDb();
const captures = readCaptures();
const runId = startRun(db, `import: ${captures.map((c) => c.capture.handle).join(",")}`);
let ok = 0, failed = 0;

for (const { name, capture } of captures) {
  const handle = normalizeHandle(capture.handle);
  const scrapedAt = capture.scrapedAt ? new Date(capture.scrapedAt) : new Date();
  if (Number.isNaN(scrapedAt.getTime())) throw new Error(`${name}: bad scrapedAt "${capture.scrapedAt}"`);
  const rows = parseRowsFromCapture(capture, scrapedAt);
  const header = parseHeaderTotals(splitLines(capture.dialogText ?? capture.modalText ?? ""));
  fs.writeFileSync(path.join(RAW_DIR, `${handle.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`), `${capture.dialogText ?? ""}\n\n-----\n\n${capture.modalText ?? ""}`);
  upsertKol(db, { handle, displayName: capture.displayName ?? null, avatarUrl: capture.avatarUrl ?? null, profileUrl: capture.url ?? profileUrl(handle), source: "config" });
  if (rows.length === 0 && header.callouts !== 0 && !/no callouts/i.test(capture.modalText ?? "")) {
    failed++;
    insertProfileSnapshot(db, { handle, runId, status: "failed", error: "no callout rows parsed from capture", source: "import" });
    log.warn(`${name}: ${handle}: no rows parsed`);
    continue;
  }
  storeProfileResult(db, handle, runId, rows, header, "import", scrapedAt);
  ok++;
  const sum = (f: (r: ParsedRow) => number | null) => rows.reduce((a, r) => a + (f(r) || 0), 0);
  log.info(`${name}: ${handle}: ${rows.length} callouts (header ${header.callouts ?? "?"}/${header.tailers ?? "?"}/${header.tailVolume ?? "?"}), 1h ${sum((r) => r.pnl1h)}, 1d ${sum((r) => r.pnl1d)}, peak ${sum((r) => r.peak)} as of ${scrapedAt.toISOString()}`);
}

finishRun(db, runId, { status: failed === 0 ? "ok" : ok ? "partial" : "failed", total: captures.length, ok, failed });
const r = exportBundle(db, cfg);
db.close();
console.log(`imported ${ok}/${captures.length} captures as run ${runId}; exported ${r.kols} KOLs / ${r.callouts} callouts to ${r.outDir}`);
process.exit(failed && !ok ? 1 : 0);
