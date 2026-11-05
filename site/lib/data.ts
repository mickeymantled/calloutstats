/**
 * Build-time data access. Server components only.
 * Reads the exporter's JSON bundle from public/data (relative to process.cwd(), i.e. site/).
 * Every loader tolerates a missing/empty dataset so the site builds with zero KOLs.
 */
import fs from "node:fs";
import path from "node:path";
import type { CalloutsBundle, Gaps, Kol, KolDetail, Meta, WindowDef } from "./types";

export const DATA_DIR = path.join(process.cwd(), "public", "data");

/** Same defaults as src/config.ts, used when meta.json does not exist yet. */
export const DEFAULT_WINDOWS: WindowDef[] = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "since", label: "Since Oct 12, 2026", since: "2026-10-12" },
  { id: "all", label: "All time" },
];

function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadMeta(): Meta {
  const m = readJson<Partial<Meta> | null>(path.join(DATA_DIR, "meta.json"), null);
  const windows = Array.isArray(m?.windows) && m!.windows!.length ? m!.windows! : DEFAULT_WINDOWS;
  const defaultWindow = m?.defaultWindow && windows.some((w) => w.id === m.defaultWindow) ? m.defaultWindow : windows[0].id;
  return {
    generatedAt: m?.generatedAt ?? null,
    run: m?.run ?? null,
    windows,
    defaultWindow,
    kolCount: m?.kolCount ?? 0,
    calloutCount: m?.calloutCount ?? 0,
    fixture: m?.fixture === true,
  };
}

export function loadKols(): Kol[] {
  const kols = readJson<Kol[]>(path.join(DATA_DIR, "kols.json"), []);
  return Array.isArray(kols) ? kols.filter((k) => k && typeof k.handle === "string") : [];
}

export function listHandles(): string[] {
  return loadKols().map((k) => k.handle);
}

/**
 * Sentinel route param used when the dataset is empty: with `output: "export"`,
 * Next refuses a dynamic route whose generateStaticParams() returns nothing.
 * Pages render an explicit "no data yet" state for it.
 */
export const PLACEHOLDER_HANDLE = "__no-data__";

export function staticHandleParams(): { handle: string }[] {
  const handles = listHandles();
  return (handles.length ? handles : [PLACEHOLDER_HANDLE]).map((handle) => ({ handle }));
}

export function findKol(handle: string): Kol | null {
  const kols = loadKols();
  return kols.find((k) => k.handle === handle) ?? kols.find((k) => k.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}

export function loadKolDetail(handle: string): KolDetail | null {
  const file = path.join(DATA_DIR, "kol", `${encodeURIComponent(handle)}.json`);
  const d = readJson<KolDetail | null>(file, null);
  if (!d) return null;
  return { ...d, callouts: Array.isArray(d.callouts) ? d.callouts : [], history: Array.isArray(d.history) ? d.history : [], windows: d.windows ?? {} };
}

/** Route params may arrive encoded or decoded depending on the handle; try both. */
export function resolveKol(param: string): KolDetail | null {
  let decoded = param;
  try { decoded = decodeURIComponent(param); } catch { /* keep raw */ }
  return loadKolDetail(decoded) ?? (decoded !== param ? loadKolDetail(param) : null);
}

export function loadCallouts(): CalloutsBundle {
  return readJson<CalloutsBundle>(path.join(DATA_DIR, "callouts.json"), { generatedAt: "", columns: [], byHandle: {} });
}

export function loadGaps(): Gaps {
  const g = readJson<Partial<Gaps> | null>(path.join(DATA_DIR, "gaps.json"), null);
  return {
    generatedAt: g?.generatedAt ?? "",
    failedProfiles: g?.failedProfiles ?? [],
    noCallouts: g?.noCallouts ?? [],
    staleProfiles: g?.staleProfiles ?? [],
    discoveredEndpoints: g?.discoveredEndpoints ?? [],
  };
}

/** The window definition to use when a page needs a single headline window. */
export function defaultWindowDef(meta: Meta): WindowDef {
  return meta.windows.find((w) => w.id === meta.defaultWindow) ?? meta.windows[0] ?? DEFAULT_WINDOWS[3];
}
