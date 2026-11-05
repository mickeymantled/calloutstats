import { describe, it, expect } from "vitest";
import { toNum, rowRe, agoRe, parseRows, parseModalText, parseHeaderTotals, splitLines, dateTextToAgeDays } from "./parser";

// Fixture modeled on the row shape documented in the spec:
//   "270 tailers · 1h +$2K · 1d +$9K · reached +$114K", "51x", "$39.3K → $2.01M MC".
// Real-row fixtures captured from pump.fun are appended in parser.realrows.test.ts
// once the first verify run has saved raw modal text.

const NOW = new Date("2026-11-04T18:00:00Z");

describe("toNum", () => {
  it("parses K and M suffixes with signs", () => {
    expect(toNum("+$2K")).toBe(2000);
    expect(toNum("+$114K")).toBe(114000);
    expect(toNum("-$1.2K")).toBe(-1200);
    expect(toNum("+$1.5M")).toBe(1500000);
    expect(toNum("-$800")).toBe(-800);
    expect(toNum("$2,340")).toBe(2340);
    expect(toNum("1,234")).toBe(1234);
  });
  it("returns null for dashes and junk", () => {
    expect(toNum("—")).toBeNull();
    expect(toNum("-")).toBeNull();
    expect(toNum("")).toBeNull();
    expect(toNum(null)).toBeNull();
    expect(toNum("abc")).toBeNull();
  });
});

describe("rowRe", () => {
  it("matches the documented row", () => {
    const m = "270 tailers · 1h +$2K · 1d +$9K · reached +$114K".match(rowRe)!;
    expect(m).not.toBeNull();
    expect(m[1]).toBe("270");
    expect(m[2]).toBe("+$2K");
    expect(m[3]).toBe("+$9K");
    expect(m[4]).toBe("+$114K");
  });
  it("matches negative values and reached —", () => {
    const m = "12 tailers · 1h -$1.2K · 1d -$800 · reached —".match(rowRe)!;
    expect(m[2]).toBe("-$1.2K");
    expect(m[3]).toBe("-$800");
    expect(m[4]).toBe("—");
  });
  it("matches thousands separators and bullet separators", () => {
    const m = "1,204 tailers • 1h +$0 • 1d +$3.4M • reached +$12.1M".match(rowRe)!;
    expect(m[1]).toBe("1,204");
    expect(m[4]).toBe("+$12.1M");
  });
});

describe("agoRe", () => {
  it("captures name and age on one line", () => {
    const a = "PEPE · 3d ago".match(agoRe)!;
    expect(a[1]).toBe("PEPE");
    expect(a[2]).toBe("3");
    expect(a[3]).toBe("d");
  });
  it("captures bare age lines", () => {
    const a = "5h ago".match(agoRe)!;
    expect(a[1]).toBe("");
    expect(a[3]).toBe("h");
  });
});

describe("parseRows", () => {
  it("parses a full row with multiplier and MC", () => {
    const text = [
      "PEPE · 3d ago",
      "270 tailers · 1h +$2K · 1d +$9K · reached +$114K",
      "51x",
      "$39.3K → $2.01M MC",
    ].join("\n");
    const rows = parseRows(text, NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.name).toBe("PEPE");
    expect(r.ageDays).toBe(3);
    expect(r.tailers).toBe(270);
    expect(r.pnl1h).toBe(2000);
    expect(r.pnl1d).toBe(9000);
    expect(r.peak).toBe(114000);
    expect(r.mult).toBe(51);
    expect(r.mc).toBe("$39.3K → $2.01M MC");
    expect(r.entryMc).toBe(39300);
    expect(r.peakMc).toBe(2010000);
  });

  it("handles negative values, reached — and a missing multiplier", () => {
    const text = [
      "RUGCOIN",
      "5h ago",
      "12 tailers · 1h -$1.2K · 1d -$800 · reached —",
      "$120K → $95K MC",
    ].join("\n");
    const r = parseRows(text, NOW)[0];
    expect(r.name).toBe("RUGCOIN");
    expect(r.ageDays).toBeCloseTo(5 / 24);
    expect(r.pnl1h).toBe(-1200);
    expect(r.pnl1d).toBe(-800);
    expect(r.peak).toBeNull();
    expect(r.mult).toBeNull();
    expect(r.entryMc).toBe(120000);
  });

  it("handles M suffixes and minute ages", () => {
    const text = [
      "MOON · 42m ago",
      "1,204 tailers · 1h +$1.5M · 1d +$3.4M · reached +$12.1M",
      "8x",
      "$1.2M → $9.6M MC",
    ].join("\n");
    const r = parseRows(text, NOW)[0];
    expect(r.tailers).toBe(1204);
    expect(r.pnl1h).toBe(1500000);
    expect(r.peak).toBe(12100000);
    expect(r.ageDays).toBeCloseTo(42 / 1440);
    expect(r.mult).toBe(8);
  });

  it("parses many rows and dedups repeats across harvests", () => {
    const block = [
      "A · 1d ago", "10 tailers · 1h +$1 · 1d +$2 · reached +$3", "2x", "$1K → $2K MC",
      "B · 2d ago", "20 tailers · 1h +$1 · 1d +$2 · reached —",
      "C · 3d ago", "30 tailers · 1h -$1 · 1d -$2 · reached +$3", "3x",
    ].join("\n");
    const rows = parseRows(block + "\n" + block, NOW);
    expect(rows.map((r) => r.name)).toEqual(["A", "B", "C"]);
    expect(rows[1].mult).toBeNull();
    expect(rows[2].mult).toBe(3);
  });

  it("handles rows with an absolute date instead of an age", () => {
    const text = ["OLD · Oct 3", "50 tailers · 1h +$1K · 1d +$2K · reached +$5K", "4x"].join("\n");
    const r = parseRows(text, NOW)[0];
    expect(r.name).toBe("OLD");
    expect(r.ageDays).toBeCloseTo(32.75, 1);
  });

  it("ignores unrelated lines", () => {
    expect(parseRows("Stats\nCallouts\nTailers\nTail volume\nnothing here", NOW)).toHaveLength(0);
  });
});

describe("parseHeaderTotals", () => {
  it("reads label-then-value layout", () => {
    const h = parseHeaderTotals(splitLines("Callouts\n142\nTailers\n12.4K\nTail volume\n$1.2M\nCallouts\nFollowers"));
    expect(h.callouts).toBe(142);
    expect(h.tailers).toBe(12400);
    expect(h.tailVolume).toBe(1200000);
  });
  it("reads value-then-label layout", () => {
    const h = parseHeaderTotals(splitLines("Stats\n142\nCallouts\n12,400\nTailers\n$1.2M\nTail volume\nCallouts\nTrades"));
    expect(h.callouts).toBe(142);
    expect(h.tailers).toBe(12400);
    expect(h.tailVolume).toBe(1200000);
  });
  it("reads inline layout", () => {
    const h = parseHeaderTotals(splitLines("Callouts: 142\nTailers: 12.4K\nTail volume: $1.2M"));
    expect(h).toEqual({ callouts: 142, tailers: 12400, tailVolume: 1200000 });
  });
  it("returns nulls when absent", () => {
    expect(parseHeaderTotals(splitLines("Callouts\nnothing"))).toEqual({ callouts: null, tailers: null, tailVolume: null });
  });
});

describe("parseModalText", () => {
  it("returns rows and header from one block", () => {
    const text = [
      "Stats", "Callouts", "2", "Tailers", "282", "Tail volume", "$45K",
      "Callouts", "Trades",
      "PEPE · 3d ago", "270 tailers · 1h +$2K · 1d +$9K · reached +$114K", "51x", "$39.3K → $2.01M MC",
      "RUG · 1d ago", "12 tailers · 1h -$1.2K · 1d -$800 · reached —",
    ].join("\n");
    const { rows, header } = parseModalText(text, NOW);
    expect(rows).toHaveLength(2);
    expect(header).toEqual({ callouts: 2, tailers: 282, tailVolume: 45000 });
  });
});

describe("dateTextToAgeDays", () => {
  it("rolls to the previous year when the date would be in the future", () => {
    const d = dateTextToAgeDays("Dec 25", new Date("2026-01-05T00:00:00Z"))!;
    expect(d).toBeCloseTo(11, 0);
  });
});
