/** Window selection shared by the client components (table, compare, picker). */
import { aggregateKol, windowStart } from "./aggregate";
import type { CalloutsBundle, Kol, Meta, WindowAgg, WindowDef } from "./types";

export const CUSTOM_ID = "custom";
export const FALLBACK_SINCE = "2026-10-12";

export interface WindowSel {
  /** a meta.windows id, or CUSTOM_ID for a user-picked start date */
  id: string;
  /** YYYY-MM-DD, only for CUSTOM_ID */
  since?: string;
}

export function defaultSel(meta: Meta): WindowSel {
  return { id: meta.windows.some((w) => w.id === meta.defaultWindow) ? meta.defaultWindow : meta.windows[0]?.id ?? "all" };
}

export const isCustom = (sel: WindowSel) => sel.id === CUSTOM_ID && !!sel.since;

/** The WindowDef a selection stands for (custom selections become a since-window). */
export function selToDef(sel: WindowSel, meta: Meta): WindowDef | null {
  if (isCustom(sel)) return { id: CUSTOM_ID, label: `Since ${sel.since}`, since: sel.since };
  return meta.windows.find((w) => w.id === sel.id) ?? null;
}

/** The "since" date to show in the date input for a selection. */
export function sinceForInput(sel: WindowSel, meta: Meta): string {
  if (isCustom(sel)) return sel.since!;
  const w = meta.windows.find((x) => x.id === sel.id);
  if (w?.since) return w.since;
  return meta.windows.find((x) => x.since)?.since ?? FALLBACK_SINCE;
}

/** Turn a typed date into a selection: snaps onto a preset since-window when it matches, else custom. */
export function selFromDate(date: string, meta: Meta): WindowSel {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { id: CUSTOM_ID, since: FALLBACK_SINCE };
  const preset = meta.windows.find((w) => w.since === date);
  return preset ? { id: preset.id } : { id: CUSTOM_ID, since: date };
}

export function selLabel(sel: WindowSel, meta: Meta): string {
  return selToDef(sel, meta)?.label ?? sel.id;
}

/** Does this selection need callouts.json (client-side math) rather than the exported aggregates? */
export function needsBundle(sel: WindowSel, kols: Kol[]): boolean {
  if (isCustom(sel)) return true;
  return kols.some((k) => !k.windows?.[sel.id]);
}

/**
 * Aggregate for one KOL. Exported numbers for preset windows, client-side math for custom dates.
 * Returns undefined while the bundle is still loading.
 */
export function resolveAgg(kol: Kol, sel: WindowSel, meta: Meta, bundle: CalloutsBundle | null, now = new Date()): WindowAgg | null | undefined {
  if (!isCustom(sel)) {
    const pre = kol.windows?.[sel.id];
    if (pre) return pre;
  }
  const def = selToDef(sel, meta);
  if (!def) return null;
  if (!bundle) return undefined;
  return aggregateKol(kol, def, bundle, now);
}

export { windowStart };
