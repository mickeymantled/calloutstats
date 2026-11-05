import { openDb } from "../db";
import { loadConfig } from "../config";
import { exportBundle } from "../export";

const cfg = loadConfig();
const db = openDb();
const r = exportBundle(db, cfg);
console.log(`exported ${r.kols} KOLs / ${r.callouts} callouts to ${r.outDir}`);
