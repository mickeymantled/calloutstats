/**
 * Callout row parser.
 *
 * Ported from pumpfun_callout_check.js (the DevTools console script). The
 * regexes, K/M number parsing, name/age back-walk, multiplier/MC forward-walk,
 * row dedup key and the scroll-until-stable loop all come from that script.
 * Extensions over the original are marked with "ext:" comments.
 */

export interface ParsedRow {
  /** Token name as rendered in the row (best effort). */
  name: string;
  /** Age of the callout in days at scrape time, null if not found. */
  ageDays: number | null;
  /** Raw age text, e.g. "3d ago". */
  ageRaw: string | null;
  tailers: number;
  pnl1h: number | null;
  pnl1d: number | null;
  /** "reached" value; null when pump.fun shows "—". */
  peak: number | null;
  /** Multiplier like 51 for "51x"; null if the row has none. */
  mult: number | null;
  /** Raw MC line, e.g. "$39.3K → $2.01M MC". */
  mc: string;
  entryMc: number | null;
  peakMc: number | null;
  /** Dedup key from the console script: name|ageDays|mult|tailers. */
  key: string;
  /** The stats line that matched rowRe. */
  raw: string;
}

export interface HeaderTotals {
  callouts: number | null;
  tailers: number | null;
  tailVolume: number | null;
}

/** "+$2K" -> 2000, "-$1.2M" -> -1200000, "—" -> null. ext: also accepts B. */
export const toNum = (s: string | null | undefined): number | null => {
  if (!s || s === "—" || s === "-") return null;
  const neg = s.trim().startsWith("-");
  const m = s.replace(/[+\-$,\s]/g, "").match(/^([\d.]+)([KMB]?)$/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (/k/i.test(m[2])) v *= 1e3;
  if (/m/i.test(m[2])) v *= 1e6;
  if (/b/i.test(m[2])) v *= 1e9; // ext
  v = Math.round(v * 1e4) / 1e4; // ext: kill float noise (2.01 * 1e6)
  return neg ? -v : v;
};

// Original: /(\d[\d,]*)\s*tailers\s*·\s*1h\s*([+\-]\$[\d.,]+[KM]?)\s*·\s*1d\s*([+\-]\$[\d.,]+[KM]?)\s*·\s*reached\s*([+\-]\$[\d.,]+[KM]?|—)/i
// ext: separator may be · or •, sign is optional, "tailer" singular, B suffix.
const SEP = "\\s*[·•]\\s*";
const AMT = "([+\\-]?\\$[\\d.,]+[KMB]?)";
export const rowRe = new RegExp(
  `(\\d[\\d,]*)\\s*tailers?${SEP}1h\\s*${AMT}${SEP}1d\\s*${AMT}${SEP}reached\\s*([+\\-]?\\$[\\d.,]+[KMB]?|—|-)`,
  "i",
);

// Original: /^(.*?)\s*·?\s*(\d+)\s*([mhd])\s*ago$/i
// ext: s / min / w / mo / y units, • separator.
export const agoRe = /^(.*?)\s*[·•]?\s*(\d+)\s*(min|mo|[smhdwy])\s*ago$/i;

// ext: fallback for rows that show an absolute date instead of "x ago".
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
export const dateRe = new RegExp(
  `^(.*?)\\s*[·•]?\\s*((?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:,?\\s*(\\d{4}))?)$`,
  "i",
);

// Original: /^(\d+)x$/   ext: allows decimals ("1.5x").
export const multRe = /^(\d+(?:\.\d+)?)x$/i;
// Original: /MC$/
export const mcLineRe = /MC$/;
export const mcPartsRe = /\$?([\d.,]+\s*[KMB]?)\s*(?:→|->|➔|⟶|=>)\s*\$?([\d.,]+\s*[KMB]?)\s*MC$/i;

const unitToDays = (unit: string, n: number): number => {
  switch (unit.toLowerCase()) {
    case "s": return n / 86400;
    case "m": case "min": return n / 1440;
    case "h": return n / 24;
    case "d": return n;
    case "w": return n * 7;
    case "mo": return n * 30;
    case "y": return n * 365;
    default: return n;
  }
};

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse a date fragment like "Oct 3" or "Oct 3, 2026" into days-ago relative to `now`. */
export function dateTextToAgeDays(text: string, now: Date): number | null {
  const m = text.trim().match(new RegExp(`^(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?$`, "i"));
  if (!m) return null;
  const mon = MONTH_INDEX[m[1].toLowerCase().slice(0, 4)] ?? MONTH_INDEX[m[1].toLowerCase().slice(0, 3)];
  if (mon === undefined) return null;
  const day = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
  let d = Date.UTC(year, mon, day);
  // No year given and the date is in the future -> it was last year.
  if (!m[3] && d > now.getTime() + 86400e3) d = Date.UTC(year - 1, mon, day);
  return (now.getTime() - d) / 86400e3;
}

export function splitLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * harvest(): port of the console script's loop. Scans every line for a stats
 * row, walks back up to 6 lines for the token name + age, walks forward up to
 * 3 lines for the multiplier and MC line. Returns rows keyed exactly as the
 * console script keyed them so repeated harvests during scrolling dedup.
 */
export function harvest(lines: string[], into: Map<string, ParsedRow> = new Map(), now: Date = new Date()): Map<string, ParsedRow> {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(rowRe);
    if (!m) continue;
    // walk back for name + age
    let name = "?", ageDays: number | null = null, ageRaw: string | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      if (rowRe.test(lines[j])) break; // ext: don't walk into the previous row
      const a = lines[j].match(agoRe);
      if (a) {
        name = a[1] || (lines[j - 1] || "?");
        const n = parseInt(a[2], 10);
        ageDays = unitToDays(a[3], n);
        ageRaw = `${a[2]}${a[3]} ago`;
        break;
      }
      const d = lines[j].match(dateRe); // ext: absolute date fallback
      if (d) {
        const days = dateTextToAgeDays(d[2], now);
        if (days !== null) {
          name = d[1] || (lines[j - 1] || "?");
          ageDays = days;
          ageRaw = d[2];
          break;
        }
      }
    }
    // walk forward for multiplier + MC
    let mult: number | null = null, mc = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      // ext: stop at the next row so a row without a multiplier doesn't borrow the next one's
      if (rowRe.test(lines[j]) || agoRe.test(lines[j]) || dateRe.test(lines[j])) break;
      const x = lines[j].match(multRe);
      if (x) mult = parseFloat(x[1]);
      if (mcLineRe.test(lines[j])) mc = lines[j];
    }
    let entryMc: number | null = null, peakMc: number | null = null;
    const mp = mc.match(mcPartsRe);
    if (mp) { entryMc = toNum(mp[1]); peakMc = toNum(mp[2]); }

    const key = `${name}|${ageDays}|${mult}|${m[1]}`;
    into.set(key, {
      name,
      ageDays,
      ageRaw,
      tailers: parseInt(m[1].replace(/,/g, ""), 10),
      pnl1h: toNum(m[2]),
      pnl1d: toNum(m[3]),
      peak: toNum(m[4]),
      mult,
      mc,
      entryMc,
      peakMc,
      key,
      raw: lines[i],
    });
  }
  return into;
}

/** Convenience: parse one block of modal text into rows. */
export function parseRows(text: string, now: Date = new Date()): ParsedRow[] {
  return [...harvest(splitLines(text), new Map(), now).values()];
}

const numericLine = (s: string | undefined): number | null => {
  if (!s) return null;
  if (!/^[+\-]?\$?[\d.,]+\s*[KMB]?$/i.test(s.trim())) return null;
  return toNum(s);
};

/**
 * Header totals shown at the top of the Stats modal: Callouts, Tailers, Tail volume.
 * Tolerates "Label\nValue", "Value\nLabel" and "Label 123" layouts. The three
 * labels are expected in that order; when all three are found two lines apart the
 * layout is decided globally (does a value follow the last label, or precede the first?).
 */
export function parseHeaderTotals(lines: string[]): HeaderTotals {
  const labels = [/^callouts$/i, /^tailers$/i, /^tail volume$/i];
  const inlineOf = (label: RegExp): number | null => {
    for (const l of lines) {
      const inline = l.match(new RegExp(`^${label.source.slice(1, -1)}\\s*[:·•]?\\s*([+\\-]?\\$?[\\d.,]+\\s*[KMB]?)$`, "i"));
      if (inline) return toNum(inline[1]);
    }
    return null;
  };
  // index of the first occurrence of the label that has a numeric neighbour
  const idxOf = (label: RegExp): number => {
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      if (numericLine(lines[i + 1]) !== null || numericLine(lines[i - 1]) !== null) return i;
    }
    return -1;
  };
  const idx = labels.map(idxOf);
  const allFound = idx.every((i) => i >= 0) && idx[1] - idx[0] === 2 && idx[2] - idx[1] === 2;
  let mode: "next" | "prev" | null = null;
  if (allFound) {
    const afterLast = numericLine(lines[idx[2] + 1]);
    const beforeFirst = numericLine(lines[idx[0] - 1]);
    if (afterLast !== null && beforeFirst === null) mode = "next";
    else if (beforeFirst !== null && afterLast === null) mode = "prev";
  }
  const valueOf = (k: number): number | null => {
    const label = labels[k];
    const i = idx[k];
    if (i < 0) return inlineOf(label);
    if (mode === "next") return numericLine(lines[i + 1]);
    if (mode === "prev") return numericLine(lines[i - 1]);
    return numericLine(lines[i + 1]) ?? numericLine(lines[i - 1]) ?? inlineOf(label);
  };
  return { callouts: valueOf(0), tailers: valueOf(1), tailVolume: valueOf(2) };
}

export interface ParsedModal {
  rows: ParsedRow[];
  header: HeaderTotals;
}

export function parseModalText(text: string, now: Date = new Date()): ParsedModal {
  const lines = splitLines(text);
  return { rows: [...harvest(lines, new Map(), now).values()], header: parseHeaderTotals(lines) };
}

/** Age (days) -> estimated absolute callout time. */
export function calloutTime(scrapedAt: Date, ageDays: number | null): Date | null {
  if (ageDays === null || !Number.isFinite(ageDays)) return null;
  return new Date(scrapedAt.getTime() - ageDays * 86400e3);
}

/** Round an age to its displayed precision so dates are stable day to day. */
export function ageDaysPrecision(ageRaw: string | null): "minute" | "hour" | "day" | "week" | "month" | "date" | null {
  if (!ageRaw) return null;
  const m = ageRaw.match(/(min|mo|[smhdwy])\s*ago$/i);
  if (!m) return "date";
  switch (m[1].toLowerCase()) {
    case "s": case "m": case "min": return "minute";
    case "h": return "hour";
    case "d": return "day";
    case "w": return "week";
    case "mo": case "y": return "month";
    default: return null;
  }
}
