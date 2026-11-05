import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WindowDef {
  id: string;
  label: string;
  /** rolling window in days */
  days?: number;
  /** fixed start date, YYYY-MM-DD (UTC) */
  since?: string;
}

export interface Config {
  includeHandles: string[];
  excludeHandles: string[];
  windows: WindowDef[];
  defaultWindow: string;
  scrapeIntervalHours: number;
  /** local hour (0-23) at/after which an interval-due run may start (collector) */
  scheduleHourLocal: number;
  /** port the local collector service (src/collector/server.ts) listens on */
  collectorPort: number;
  /** leaderboard views to scrape: all | monthly | weekly | daily */
  leaderboardViews: string[];
  delayBetweenProfilesMs: [number, number];
  maxRetriesPerProfile: number;
  /** 0 = no cap */
  maxProfilesPerRun: number;
  browser: {
    /** playwright channel, e.g. "chrome"; null = bundled chromium */
    channel: string | null;
    headless: boolean;
    userDataDir: string;
    timezoneId: string;
  };
  export: { siteDataDir: string };
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fromRoot = (...p: string[]) => path.resolve(ROOT, ...p);
export const DB_PATH = fromRoot("data", "callouts.sqlite");
export const RAW_DIR = fromRoot("data", "raw");
export const RUNS_DIR = fromRoot("data", "runs");
export const LOG_DIR = fromRoot("data", "logs");
export const ENDPOINTS_PATH = fromRoot("data", "discovered_endpoints.json");

const DEFAULTS: Config = {
  includeHandles: [],
  excludeHandles: [],
  windows: [
    { id: "7d", label: "7 days", days: 7 },
    { id: "30d", label: "30 days", days: 30 },
    { id: "since", label: "Since Oct 12, 2026", since: "2026-10-12" },
    { id: "all", label: "All time" },
  ],
  defaultWindow: "since",
  scrapeIntervalHours: 24,
  scheduleHourLocal: 6,
  collectorPort: 47831,
  leaderboardViews: ["all", "monthly"],
  delayBetweenProfilesMs: [2000, 4000],
  maxRetriesPerProfile: 3,
  maxProfilesPerRun: 0,
  browser: { channel: null, headless: false, userDataDir: "data/browser-profile", timezoneId: "America/Los_Angeles" },
  export: { siteDataDir: "site/public/data" },
};

export function loadConfig(file = fromRoot("config.json")): Config {
  let user: Partial<Config> = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg: Config = {
    ...DEFAULTS,
    ...user,
    browser: { ...DEFAULTS.browser, ...(user.browser ?? {}) },
    export: { ...DEFAULTS.export, ...(user.export ?? {}) },
  };
  cfg.includeHandles = (cfg.includeHandles ?? []).map(normalizeHandle);
  cfg.excludeHandles = (cfg.excludeHandles ?? []).map(normalizeHandle);
  return cfg;
}

export const normalizeHandle = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/pump\.fun\/profile\//i, "").replace(/[/?#].*$/, "");

export const profileUrl = (handle: string) => `https://pump.fun/profile/${encodeURIComponent(handle)}`;

export function ensureDirs() {
  for (const d of [fromRoot("data"), RAW_DIR, RUNS_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });
}
