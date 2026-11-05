import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config";

const stamp = () => new Date().toISOString();

function write(level: string, args: unknown[]) {
  const line = `${stamp()} [${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  if (level === "error") console.error(line); else console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${stamp().slice(0, 10)}.log`), line + "\n");
  } catch { /* logging must never crash the run */ }
}

export const log = {
  info: (...a: unknown[]) => write("info", a),
  warn: (...a: unknown[]) => write("warn", a),
  error: (...a: unknown[]) => write("error", a),
  debug: (...a: unknown[]) => { if (process.env.DEBUG) write("debug", a); },
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const randBetween = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
