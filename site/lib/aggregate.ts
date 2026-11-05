/**
 * Mirror of aggregate() / windowStart() / rewardsViewForWindow() in ../src/export.ts.
 * The site uses this to compute custom-date windows client side from callouts.json.
 * Keep the two in lock-step, including the median rule sorted[floor(n/2)].
 */
import type { CalloutsBundle, Kol, WindowAgg, WindowDef } from "./types";

export interface CompactCallout {
  at: number;
  tailers: number;
  pnl1h: number | null;
  pnl1d: number | null;
  peak: number | null;
}

/** Which leaderboard view best matches a window. */
export function rewardsViewForWindow(w: WindowDef): string {
  if (w.days === 1) return "daily";
  if (w.days === 7) return "weekly";
  if (w.days === 30) return "monthly";
  return "all";
}

export function windowStart(w: WindowDef, now: Date): number | null {
  if (w.days) return now.getTime() - w.days * 86400e3;
  if (w.since) return Date.parse(w.since + "T00:00:00Z");
  return null;
}

export function aggregate(
  rows: CompactCallout[],
  start: number | null,
  rewards: { value: number | null; unit: string | null },
): WindowAgg {
  const inWin = start === null ? rows : rows.filter((r) => r.at >= start);
  const withPeak = inWin.filter((r) => r.peak !== null);
  const sum = (f: (r: CompactCallout) => number | null) => inWin.reduce((a, r) => a + (f(r) || 0), 0);
  const peaks = withPeak.map((r) => r.peak as number).sort((a, b) => a - b);
  const peak = sum((r) => r.peak);
  return {
    callouts: inWin.length,
    calloutsWithPeak: withPeak.length,
    tailers: sum((r) => r.tailers),
    pnl1h: sum((r) => r.pnl1h),
    pnl1d: sum((r) => r.pnl1d),
    peak,
    peakMedian: peaks.length ? peaks[Math.floor(peaks.length / 2)] : null,
    rewards: rewards.value,
    rewardsUnit: rewards.unit,
    rewardsToPeak: rewards.value !== null && peak > 0 ? rewards.value / peak : null,
  };
}

/** Expand the compact callouts.json rows for one handle. */
export function compactRows(rows: (number | null)[][] | undefined): CompactCallout[] {
  if (!rows) return [];
  return rows.map((r) => ({
    at: (r[0] ?? 0) * 1000,
    tailers: r[1] ?? 0,
    pnl1h: r[2] ?? null,
    pnl1d: r[3] ?? null,
    peak: r[4] ?? null,
  }));
}

/** Rewards entry the exporter would pick for a window (view, falling back to all-time). */
export function rewardsForWindow(kol: Kol, w: WindowDef): { value: number | null; unit: string | null } {
  const rv = kol.rewards?.[rewardsViewForWindow(w)] ?? kol.rewards?.["all"];
  return { value: rv?.value ?? null, unit: rv?.unit ?? null };
}

/** Aggregate one KOL for an arbitrary window from the compact bundle (client side). */
export function aggregateKol(kol: Kol, w: WindowDef, bundle: CalloutsBundle, now = new Date()): WindowAgg {
  return aggregate(compactRows(bundle.byHandle[kol.handle]), windowStart(w, now), rewardsForWindow(kol, w));
}
