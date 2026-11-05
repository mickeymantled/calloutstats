import { describe, it, expect } from "vitest";
import { parseModalText, normalizeLines, splitLines, toNum } from "./parser";

/**
 * The Stats modal of pump.fun/profile/mickeymantled as its innerText read on
 * 2026-11-04 (18:57 PT), "LAST ROUND" range, 13 callouts. Copied verbatim:
 * every row is spread over twelve lines, negatives use U+2212 MINUS SIGN, and
 * "—" stands for a missing 1d or reached value.
 */
const MINUS = "−";
const REAL_MODAL = [
  "Stats", "@mickeymantled", "Callouts", "Streaks", "Volume", "LAST ROUND", "TODAY", "1W", "1M",
  "Callouts", "13", "7 new · 6 earlier", "Tailers", "1,899", "Top 0.25% of 5,173", "Tail volume", "$120K", "Top 0.25% of 5,173",
  "Callouts", "Recent",
  "X", "·", "19h ago", "1.1x", "$152K", "$178K MC", "50 tailers · 1h", `${MINUS}$1K`, "· 1d", "—", "· reached", "+$1K",
  "RAMINU", "·", "20h ago", "1.4x", "$25.4K", "$35.9K MC", "44 tailers · 1h", `${MINUS}$272`, "· 1d", "—", "· reached", "+$137",
  "Polycat", "·", "1d ago", "15x", "$6.09K", "$91.1K MC", "246 tailers · 1h", `${MINUS}$2K`, "· 1d", `${MINUS}$2K`, "· reached", "+$45K",
  "Other", "·", "1d ago", "8x", "$60.5K", "$467K MC", "377 tailers · 1h", "+$2K", "· 1d", "+$1K", "· reached", "+$95K",
  "Trump", "·", "1d ago", "1.5x", "$21K", "$32K MC", "36 tailers · 1h", `${MINUS}$438`, "· 1d", `${MINUS}$439`, "· reached", "+$215",
  "X", "·", "1d ago", "1.2x", "$64K", "$79.9K MC", "116 tailers · 1h", `${MINUS}$981`, "· 1d", `${MINUS}$1K`, "· reached", "+$3K",
  "E", "·", "1d ago", "3x", "$189K", "$496K MC", "159 tailers · 1h", "+$1K", "· 1d", `${MINUS}$2K`, "· reached", "+$22K",
  "PumpFun", "·", "1d ago", "4x", "$48.2K", "$183K MC", "225 tailers · 1h", "+$3K", "· 1d", `${MINUS}$4K`, "· reached", "+$40K",
  "George", "·", "2d ago", "5x", "$15.1K", "$77.6K MC", "139 tailers · 1h", `${MINUS}$609`, "· 1d", `${MINUS}$698`, "· reached", "+$14K",
  "MOVEMBER", "·", "3d ago", "12x", "$44.8K", "$539K MC", "234 tailers · 1h", "+$2K", "· 1d", "+$2K", "· reached", "+$59K",
  "RAM", "·", "3d ago", "12x", "$204K", "$2.49M MC", "154 tailers · 1h", `${MINUS}$2K`, "· 1d", `${MINUS}$2K`, "· reached", "+$4K",
  "NICKI", "·", "10d ago", "7x", "$37K", "$242K MC", "552 tailers · 1h", "+$3K", "· 1d", "+$165", "· reached", "+$62K",
  "BTC", "·", "13d ago", "21x", "$1.01M", "$21.7M MC", "35 tailers · 1h", `${MINUS}$28`, "· 1d", `${MINUS}$17`, "· reached", "+$438",
  "Performance", "Reached 2x+", "69.2%", "13 calls", "1.2x+", "92.3%", "1.5x+", "76.9%", "10.0x+", "30.8%",
  "Avg", "7.1x", "Med", "5.2x", "Time to peak", "13h 20m 26s",
  "Outcome spread", "1.0x", "1.1x", "1.2x", "1.3x", "1.4x", "1.7x", "2.0x", "3.0x", "5.0x", "10.0x", "20.0x+",
  "", "Updated Nov 4, 2026, 6:57 PM",
].join("\n");

const NOW = new Date("2026-11-05T02:57:00Z");

describe("real pump.fun modal text (2026-11-04)", () => {
  const { rows, header } = parseModalText(REAL_MODAL, NOW);
  const by = (name: string, ageRaw: string) => rows.find((r) => r.name === name && r.ageRaw === ageRaw)!;

  it("finds all 13 callouts and nothing from the Performance footer", () => {
    expect(rows).toHaveLength(13);
    expect(rows.map((r) => r.name)).toEqual(["X", "RAMINU", "Polycat", "Other", "Trump", "X", "E", "PumpFun", "George", "MOVEMBER", "RAM", "NICKI", "BTC"]);
    expect(rows.every((r) => r.mult !== null && r.mult < 30)).toBe(true); // no "1.0x" from "Outcome spread"
  });

  it("reads the header totals despite the extra lines between the pairs", () => {
    expect(header).toEqual({ callouts: 13, tailers: 1899, tailVolume: 120000 });
  });

  it("parses a row with a Unicode minus, a missing 1d value and a decimal multiplier", () => {
    const x = by("X", "19h ago");
    expect(x.tailers).toBe(50);
    expect(x.pnl1h).toBe(-1000);
    expect(x.pnl1d).toBeNull();
    expect(x.peak).toBe(1000);
    expect(x.mult).toBe(1.1);
    expect(x.entryMc).toBe(152000);
    expect(x.peakMc).toBe(178000);
    expect(x.mc).toBe("$152K → $178K MC");
    expect(x.ageDays).toBeCloseTo(19 / 24, 6);
  });

  it("keeps two callouts with the same token name apart", () => {
    const later = by("X", "1d ago");
    expect(later.tailers).toBe(116);
    expect(later.mult).toBe(1.2);
    expect(later.key).not.toBe(by("X", "19h ago").key);
  });

  it("parses the oldest row with M suffixes", () => {
    const btc = by("BTC", "13d ago");
    expect(btc).toMatchObject({ tailers: 35, pnl1h: -28, pnl1d: -17, peak: 438, mult: 21, entryMc: 1010000, peakMc: 21700000, ageDays: 13 });
  });

  it("sums match hand-added figures", () => {
    const sum = (f: (r: (typeof rows)[number]) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
    expect(sum((r) => r.tailers)).toBe(2367);
    expect(sum((r) => r.pnl1h)).toBe(3672);
    expect(sum((r) => r.pnl1d)).toBe(-8989);
    expect(sum((r) => r.peak)).toBe(345790);
    expect(rows.filter((r) => r.pnl1d === null)).toHaveLength(2);
  });

  it("normalizes the split layout into the console script's single-line layout", () => {
    const lines = normalizeLines(splitLines(REAL_MODAL));
    expect(lines).toContain("X · 19h ago");
    expect(lines).toContain("$152K → $178K MC");
    expect(lines).toContain("50 tailers · 1h -$1K · 1d — · reached +$1K");
    expect(lines).toContain("35 tailers · 1h -$28 · 1d -$17 · reached +$438");
    // idempotent on text that is already single-line
    expect(normalizeLines(lines)).toEqual(lines);
  });

  it("parses the same rows from the extension's per-row blocks as from the whole text", () => {
    // content-profile.js ships lines[i-7 .. i+8] around every "N tailers" line
    const lines = splitLines(REAL_MODAL);
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i++) if (/^\d[\d,]*\s*tailers?\b/i.test(lines[i])) blocks.push(lines.slice(Math.max(0, i - 7), i + 9).join("\n"));
    expect(blocks).toHaveLength(13);
    const fromBlocks = blocks.flatMap((b) => parseModalText(b, NOW).rows);
    expect(fromBlocks.map((r) => r.key)).toEqual(rows.map((r) => r.key));
    expect(fromBlocks.map((r) => [r.name, r.mult, r.mc])).toEqual(rows.map((r) => [r.name, r.mult, r.mc]));
  });

  it("toNum accepts the Unicode minus", () => {
    expect(toNum(`${MINUS}$1.5K`)).toBe(-1500);
    expect(toNum("—")).toBeNull();
    expect(toNum("–")).toBeNull();
  });
});

/** Odd rows from the same profile's 1M range (472 rows on the page, 331 with stats). */
const ODD_ROWS = [
  "HYPEHOUSE", "·", "6d ago", "1.7x", "$90.6K", "$160K MC", "114 tailers · 1h", `${MINUS}$2K`, "· 1d", `${MINUS}$2K`, "· reached", "+$7K",
  "BS", "·", "7d ago", "—", "$158K", "— MC", "31 tailers · 1h", `${MINUS}$551`, "· 1d", `${MINUS}$573`, "· reached", "+$490",
  "CI", "·", "13d ago", "1.5x", "$161K", "$257K MC", "65 tailers · 1h", `${MINUS}$2K`, "· 1d", `${MINUS}$2K`, "· reached", "$0",
  "LOAD", "·", "23d ago", "4x", "$3.57M", "$15M MC", "9 tailers · 1h", "—", "· 1d", "—", "· reached", "—",
  "HIRE", "·", "23d ago", "51x", "$39.3K", "$2.01M MC", "270 tailers · 1h", "+$2K", "· 1d", "+$9K", "· reached", "—",
  "BTCKNIGHT", "·", "23d ago", "1.6x", "$7.41K", "$12.4K MC",
  "Solami", "·", "23d ago", "1.2x", "$26.6K", "$33.5K MC",
  "Performance", "Reached 2x+", "58.1%", "473 calls",
].join("\n");

describe("odd real rows: dashes for multiplier / peak MC / every figure, $0 peaks, callouts without stats", () => {
  const { rows } = parseModalText(ODD_ROWS, NOW);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));

  it("stores only the callouts that have a stats line", () => {
    expect(rows.map((r) => r.name)).toEqual(["HYPEHOUSE", "BS", "CI", "LOAD", "HIRE"]);
  });

  it("a dash multiplier and a dash peak MC parse as nulls, the entry MC survives", () => {
    expect(by.BS).toMatchObject({ mult: null, entryMc: 158000, peakMc: null, mc: "$158K → — MC", peak: 490, pnl1h: -551, pnl1d: -573 });
  });

  it("reached $0 is a zero, not a missing value", () => {
    expect(by.CI.peak).toBe(0);
  });

  it("a row with every figure dashed keeps its multiplier and MCs", () => {
    expect(by.LOAD).toMatchObject({ tailers: 9, pnl1h: null, pnl1d: null, peak: null, mult: 4, entryMc: 3570000, peakMc: 15000000 });
  });

  it("the last stats row does not borrow the multiplier of the stat-less row below it", () => {
    expect(by.HIRE).toMatchObject({ tailers: 270, pnl1h: 2000, pnl1d: 9000, peak: null, mult: 51, entryMc: 39300, peakMc: 2010000 });
  });
});
