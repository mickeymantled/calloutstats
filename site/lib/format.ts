/** Number / date formatting shared by server and client components. Locale-free so SSR and hydration agree. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 1234 -> "1.23K", 2_010_000 -> "2.01M", 0.5 -> "0.5" */
export function fmtCompact(abs: number): string {
  if (abs >= 1e9) return trimZeros((abs / 1e9).toFixed(abs >= 1e10 ? 1 : 2)) + "B";
  if (abs >= 1e6) return trimZeros((abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)) + "M";
  if (abs >= 1e3) return trimZeros((abs / 1e3).toFixed(abs >= 1e4 ? 1 : 2)) + "K";
  if (abs >= 100) return Math.round(abs).toString();
  if (abs >= 10) return trimZeros(abs.toFixed(1));
  return trimZeros(abs.toFixed(2));
}

/** $ with K/M suffix. sign=true prefixes "+" on positives (PNL style). null -> "—". */
export function fmtMoney(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (!isNum(v)) return "—";
  const body = "$" + fmtCompact(Math.abs(v));
  if (v < 0) return "-" + body;
  if (v > 0 && opts.sign) return "+" + body;
  return body;
}

/** Rewards carry a unit from the leaderboard: USD -> "$1.2K", SOL -> "12.3 SOL". */
export function fmtRewards(v: number | null | undefined, unit: string | null | undefined): string {
  if (!isNum(v)) return "—";
  if (!unit || /^usd$/i.test(unit)) return fmtMoney(v);
  return `${v < 0 ? "-" : ""}${fmtCompact(Math.abs(v))} ${unit}`;
}

/** Thousands-grouped integer. */
export function fmtInt(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const r = Math.round(v);
  const s = Math.abs(r).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (r < 0 ? "-" : "") + s;
}

/** 51 -> "51x", 1.5 -> "1.5x" */
export function fmtMult(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  return (v >= 10 ? Math.round(v).toString() : trimZeros(v.toFixed(1))) + "x";
}

/** Ratio -> percent: 0.0123 -> "1.23%", 2.5 -> "250%" */
export function fmtPct(ratio: number | null | undefined): string {
  if (!isNum(ratio)) return "—";
  const p = ratio * 100;
  const abs = Math.abs(p);
  if (abs > 0 && abs < 0.01) return (p < 0 ? "-" : "") + "<0.01%";
  const s = abs >= 100 ? fmtInt(abs) : abs >= 10 ? trimZeros(abs.toFixed(1)) : trimZeros(abs.toFixed(2));
  return (p < 0 ? "-" : "") + s + "%";
}

/** Plain ratio: 3.2 -> "3.2x", 0.4 -> "0.4x" */
export function fmtRatio(ratio: number | null | undefined): string {
  if (!isNum(ratio)) return "—";
  const abs = Math.abs(ratio);
  const s = abs >= 100 ? fmtInt(abs) : abs >= 10 ? trimZeros(abs.toFixed(1)) : trimZeros(abs.toFixed(2));
  return (ratio < 0 ? "-" : "") + s + "x";
}

/** CSS class for a signed number. */
export function signClass(v: number | null | undefined): string {
  if (!isNum(v)) return "na";
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "zero";
}

function pad(n: number) { return n < 10 ? "0" + n : String(n); }

/** "Nov 4, 2026" (UTC). Accepts ISO strings or YYYY-MM-DD. */
export function fmtDateUTC(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T00:00:00Z" : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Nov 4, 2026 06:12 UTC" */
export function fmtDateTimeUTC(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDateUTC(iso)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "3h ago", "2d ago" relative to now. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

/**
 * Parse a user-typed money figure: "$1.2M", "250k", "-3,000", "+12.5 K", "1e6".
 * Returns null when it cannot be read.
 */
export function parseMoneyInput(raw: string): number | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[,$\s_]/g, "").replace(/^\+/, "").replace(/^[−–]/, "-");
  if (!s) return null;
  const m = s.match(/^(-?\d*\.?\d+(?:e[+-]?\d+)?)([kmb])?$/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const suf = (m[2] || "").toLowerCase();
  if (suf === "k") v *= 1e3;
  else if (suf === "m") v *= 1e6;
  else if (suf === "b") v *= 1e9;
  return Math.round(v * 1e4) / 1e4;
}
