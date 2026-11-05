/**
 * Shapes of the JSON bundle written by ../src/export.ts into public/data/.
 * Keep in sync with the exporter; it is the contract the site consumes.
 */

export interface WindowDef {
  id: string;
  label: string;
  /** rolling window in days */
  days?: number;
  /** fixed start date, YYYY-MM-DD (UTC) */
  since?: string;
}

export interface RunMeta {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string; // ok | partial | failed
  profilesTotal: number;
  profilesOk: number;
  profilesFailed: number;
  notes: string | null;
}

export interface Meta {
  generatedAt: string | null;
  run: RunMeta | null;
  windows: WindowDef[];
  defaultWindow: string;
  kolCount: number;
  calloutCount: number;
  /** set by scripts/make-fixture-data.ts; never present on real data */
  fixture?: boolean;
}

export interface WindowAgg {
  callouts: number;
  calloutsWithPeak: number;
  tailers: number;
  pnl1h: number;
  pnl1d: number;
  peak: number;
  peakMedian: number | null;
  rewards: number | null;
  rewardsUnit: string | null;
  rewardsToPeak: number | null;
}

export interface RewardEntry {
  value: number | null;
  rank: number | null;
  unit: string | null;
  at: string;
}

export interface HeaderTotals {
  callouts: number | null;
  tailers: number | null;
  tailVolume: number | null;
  at: string;
}

export interface Kol {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string;
  source: string;
  header: HeaderTotals | null;
  rewards: Record<string, RewardEntry>;
  lastScrapedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  windows: Record<string, WindowAgg>;
}

export interface Snapshot {
  at: string;
  tailers: number | null;
  pnl1h: number | null;
  pnl1d: number | null;
  peak: number | null;
}

export interface Callout {
  id: number;
  token: string;
  calloutAt: string;
  calloutDate: string;
  agePrecision: string | null;
  ageKnown: boolean;
  ageRaw: string | null;
  firstSeenAt: string;
  scrapedAt: string;
  tailers: number | null;
  pnl1h: number | null;
  pnl1d: number | null;
  peak: number | null;
  mult: number | null;
  entryMc: number | null;
  peakMc: number | null;
  mcRaw: string | null;
  snapshots: Snapshot[];
}

export interface HistoryPoint {
  runId: number;
  at: string;
  callouts: number;
  peakSum: number;
  pnl1dSum: number;
  pnl1hSum: number;
  tailers: number;
}

export interface KolDetail extends Kol {
  generatedAt: string;
  callouts: Callout[];
  history: HistoryPoint[];
}

/** callouts.json: compact rows [calloutAtEpochSec, tailers, pnl1h, pnl1d, peak] */
export interface CalloutsBundle {
  generatedAt: string;
  columns: string[];
  byHandle: Record<string, (number | null)[][]>;
}

export interface Gaps {
  generatedAt: string;
  failedProfiles: { handle: string; error: string | null; at: string }[];
  noCallouts: string[];
  staleProfiles: { handle: string; lastScrapedAt: string }[];
  discoveredEndpoints: { url: string; hits: number; keys: string[] }[];
}
