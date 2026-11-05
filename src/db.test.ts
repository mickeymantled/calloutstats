import { describe, it, expect } from "vitest";
import {
  openDb,
  upsertKol,
  startRun,
  finishRun,
  matchOrCreateCallout,
  insertCalloutSnapshot,
  storeProfileResult,
  type DB,
} from "./db";
import type { ParsedRow, HeaderTotals } from "./parser";
import { aggregate, rewardsViewForWindow, windowStart, type CompactCallout } from "./export";

const HANDLE = "mickeymantled";
const T = (iso: string) => new Date(iso);

/** A parsed row modeled on the documented pump.fun row; override what a test cares about. */
function row(over: Partial<ParsedRow> = {}): ParsedRow {
  const r: ParsedRow = {
    name: "PUMP",
    ageDays: 3,
    ageRaw: "3d ago",
    tailers: 270,
    pnl1h: 2000,
    pnl1d: 9000,
    peak: 114000,
    mult: 51,
    mc: "$39.3K → $2.01M MC",
    entryMc: 39300,
    peakMc: 2010000,
    key: "",
    raw: "270 tailers · 1h +$2K · 1d +$9K · reached +$114K",
    ...over,
  };
  r.key = `${r.name}|${r.ageDays}|${r.mult}|${r.tailers}`;
  return r;
}

function setup(): DB {
  const db = openDb(":memory:");
  upsertKol(db, { handle: HANDLE, profileUrl: `https://pump.fun/profile/${HANDLE}`, source: "config" });
  return db;
}

/** One scrape of one row: match-or-create the callout and append a snapshot. */
function scrape(db: DB, r: ParsedRow, scrapedAt: Date, runId: number): number {
  const id = matchOrCreateCallout(db, HANDLE, r, scrapedAt, runId);
  insertCalloutSnapshot(db, id, runId, r, scrapedAt);
  return id;
}

const callout = (db: DB, id: number) => db.prepare(`SELECT * FROM callouts WHERE id = ?`).get(id) as any;
const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n as number;
const snapshots = (db: DB, id: number) =>
  db.prepare(`SELECT * FROM callout_snapshots WHERE callout_id = ? ORDER BY scraped_at, id`).all(id) as any[];

describe("openDb(':memory:')", () => {
  it("creates the schema", () => {
    const db = setup();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[]).map((t) => t.name);
    for (const t of ["kols", "runs", "callouts", "callout_snapshots", "reward_snapshots", "profile_snapshots"]) expect(tables).toContain(t);
    expect(count(db, "kols")).toBe(1);
  });
});

describe("matchOrCreateCallout", () => {
  it("(a) same handle+token+date on two scrapes -> one callout, two appended snapshots", () => {
    const db = setup();
    const run1 = startRun(db);
    const run2 = startRun(db);

    const id1 = scrape(db, row({ ageDays: 3, ageRaw: "3d ago", peak: 114000 }), T("2026-11-04T12:00:00Z"), run1);
    const id2 = scrape(db, row({ ageDays: 4, ageRaw: "4d ago", peak: 150000, pnl1d: 12000 }), T("2026-11-05T12:00:00Z"), run2);

    expect(id2).toBe(id1);
    expect(count(db, "callouts")).toBe(1);
    const c = callout(db, id1);
    expect(c.callout_date).toBe("2026-11-01");
    expect(c.callout_at).toBe("2026-11-01T12:00:00.000Z");
    expect(c.age_known).toBe(1);
    expect(c.age_precision).toBe("day");
    expect(c.first_run_id).toBe(run1);

    const snaps = snapshots(db, id1);
    expect(snaps).toHaveLength(2);
    expect(snaps.map((s) => s.run_id)).toEqual([run1, run2]);
    expect(snaps.map((s) => s.peak)).toEqual([114000, 150000]); // day 1 kept, day 2 appended
    expect(snaps.map((s) => s.pnl_1d)).toEqual([9000, 12000]);
    expect(snaps.map((s) => s.age_raw)).toEqual(["3d ago", "4d ago"]);
  });

  it("(b) estimated dates drifting by one day still match; two days apart do not", () => {
    const db = setup();
    const run1 = startRun(db);
    const run2 = startRun(db);

    // "3d ago" late on Nov 4 -> Nov 1 23:30. "4d ago" early on Nov 6 -> Nov 2 01:00: the date moved by a day.
    const id1 = scrape(db, row({ ageDays: 3, ageRaw: "3d ago" }), T("2026-11-04T23:30:00Z"), run1);
    expect(callout(db, id1).callout_date).toBe("2026-11-01");
    const id2 = scrape(db, row({ ageDays: 4, ageRaw: "4d ago" }), T("2026-11-06T01:00:00Z"), run2);
    expect(id2).toBe(id1);
    expect(callout(db, id1).callout_date).toBe("2026-11-01"); // first estimate is kept
    expect(snapshots(db, id1)).toHaveLength(2);

    // same token, same MC, but dated two days before the stored estimate -> a different callout
    const id3 = scrape(db, row({ ageDays: 7, ageRaw: "7d ago" }), T("2026-11-06T01:00:00Z"), run2);
    expect(id3).not.toBe(id1);
    expect(callout(db, id3).callout_date).toBe("2026-10-30");
    expect(count(db, "callouts")).toBe(2);
  });

  it("(c) same token and date but entry MC differing by more than 2% -> separate callouts", () => {
    const db = setup();
    const run1 = startRun(db);
    const at = T("2026-11-04T12:00:00Z");

    const a = scrape(db, row({ entryMc: 39300, mc: "$39.3K → $2.01M MC" }), at, run1);
    const b = scrape(db, row({ entryMc: 50000, mc: "$50K → $1M MC", tailers: 40 }), at, run1);
    expect(b).not.toBe(a);
    expect(count(db, "callouts")).toBe(2);
    expect(callout(db, a).entry_mc).toBe(39300);
    expect(callout(db, b).entry_mc).toBe(50000);

    // within 2% (39.3K vs 39.9K, 1.5%) is still the same callout
    const run2 = startRun(db);
    const c = scrape(db, row({ entryMc: 39900, ageDays: 4, ageRaw: "4d ago" }), T("2026-11-05T12:00:00Z"), run2);
    expect(c).toBe(a);
    expect(count(db, "callouts")).toBe(2);
    expect(snapshots(db, a)).toHaveLength(2);
    expect(snapshots(db, b)).toHaveLength(1);
  });

  it("(d) a null entry MC on either side still matches, and the stored MC gets filled in", () => {
    const db = setup();
    const run1 = startRun(db);
    const run2 = startRun(db);
    const at1 = T("2026-11-04T12:00:00Z");
    const at2 = T("2026-11-05T12:00:00Z");

    // first sight without an MC line, then with one
    const a = scrape(db, row({ entryMc: null, peakMc: null, mc: "" }), at1, run1);
    expect(callout(db, a).entry_mc).toBeNull();
    const a2 = scrape(db, row({ ageDays: 4, ageRaw: "4d ago" }), at2, run2); // entryMc 39300
    expect(a2).toBe(a);
    expect(callout(db, a).entry_mc).toBe(39300);

    // reverse: stored MC, incoming row without one
    const b = scrape(db, row({ name: "WIF", entryMc: 12000, mc: "$12K → $300K MC" }), at1, run1);
    const b2 = scrape(db, row({ name: "WIF", entryMc: null, peakMc: null, mc: "", ageDays: 4, ageRaw: "4d ago" }), at2, run2);
    expect(b2).toBe(b);
    expect(callout(db, b).entry_mc).toBe(12000);

    expect(count(db, "callouts")).toBe(2);
    expect(count(db, "callout_snapshots")).toBe(4);
  });

  it("(e) unknown age -> age_known 0 with the scrape time as placeholder; a later dated row refines it", () => {
    const db = setup();
    const run1 = startRun(db);
    const run2 = startRun(db);
    const at1 = T("2026-11-04T12:00:00Z");

    const id = scrape(db, row({ ageDays: null, ageRaw: null }), at1, run1);
    let c = callout(db, id);
    expect(c.age_known).toBe(0);
    expect(c.callout_at).toBe(at1.toISOString());
    expect(c.callout_date).toBe("2026-11-04");
    expect(c.age_precision).toBeNull();
    expect(snapshots(db, id)[0].age_days).toBeNull();

    // next day the same row parses with "5d ago": same callout, date refined to Oct 31
    const id2 = scrape(db, row({ ageDays: 5, ageRaw: "5d ago" }), T("2026-11-05T12:00:00Z"), run2);
    expect(id2).toBe(id);
    c = callout(db, id);
    expect(c.age_known).toBe(1);
    expect(c.callout_at).toBe("2026-10-31T12:00:00.000Z");
    expect(c.callout_date).toBe("2026-10-31");
    expect(c.age_precision).toBe("day");
    expect(count(db, "callouts")).toBe(1);
    expect(snapshots(db, id)).toHaveLength(2);

    // once refined the estimate is stable: a third dated scrape matches and does not move it
    const id3 = scrape(db, row({ ageDays: 6, ageRaw: "6d ago" }), T("2026-11-06T12:00:00Z"), startRun(db));
    expect(id3).toBe(id);
    expect(callout(db, id).callout_date).toBe("2026-10-31");
    expect(snapshots(db, id)).toHaveLength(3);
  });

  it("a row whose age fails to parse attaches to the existing dated callout instead of creating a phantom", () => {
    const db = setup();
    const run1 = startRun(db);
    const run2 = startRun(db);
    const id = scrape(db, row({ ageDays: 30, ageRaw: "30d ago" }), T("2026-11-04T12:00:00Z"), run1);
    const id2 = scrape(db, row({ ageDays: null, ageRaw: null }), T("2026-11-05T12:00:00Z"), run2);
    expect(id2).toBe(id);
    const c = callout(db, id);
    expect(c.age_known).toBe(1);
    expect(c.callout_date).toBe("2026-10-05"); // the known date wins over the placeholder
    expect(count(db, "callouts")).toBe(1);
    expect(snapshots(db, id)).toHaveLength(2);
  });

  it("different tokens or handles never match", () => {
    const db = setup();
    upsertKol(db, { handle: "other", profileUrl: "https://pump.fun/profile/other", source: "config" });
    const run = startRun(db);
    const at = T("2026-11-04T12:00:00Z");
    const a = scrape(db, row(), at, run);
    const b = scrape(db, row({ name: "pump" }), at, run); // token names are case-sensitive as rendered
    const c = matchOrCreateCallout(db, "other", row(), at, run);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("storeProfileResult", () => {
  it("stores every row plus a profile snapshot per run, appending snapshots on the next run", () => {
    const db = setup();
    const header: HeaderTotals = { callouts: 2, tailers: 300, tailVolume: 1_200_000 };
    const rows = [row({ name: "PUMP" }), row({ name: "WIF", ageDays: 1, ageRaw: "1d ago", entryMc: 12000, mc: "$12K → $300K MC" })];

    const run1 = startRun(db, "test");
    storeProfileResult(db, HANDLE, run1, rows, header);
    finishRun(db, run1, { status: "ok", total: 1, ok: 1, failed: 0 });

    expect(count(db, "callouts")).toBe(2);
    expect(count(db, "callout_snapshots")).toBe(2);
    const prof = db.prepare(`SELECT * FROM profile_snapshots WHERE handle = ?`).all(HANDLE) as any[];
    expect(prof).toHaveLength(1);
    expect(prof[0]).toMatchObject({ run_id: run1, status: "ok", header_callouts: 2, header_tailers: 300, header_tail_volume: 1_200_000, rows_parsed: 2, source: "dom" });
    const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(run1) as any;
    expect(run.status).toBe("ok");
    expect(run.finished_at).not.toBeNull();
    expect(run.notes).toBe("test");

    const run2 = startRun(db);
    storeProfileResult(db, HANDLE, run2, rows, header, "api");
    expect(count(db, "callouts")).toBe(2); // matched, not duplicated
    expect(count(db, "callout_snapshots")).toBe(4);
    expect(count(db, "profile_snapshots")).toBe(2);
    expect((db.prepare(`SELECT source FROM profile_snapshots WHERE run_id = ?`).get(run2) as any).source).toBe("api");
  });
});

describe("export aggregate()", () => {
  const day = (n: number) => Date.UTC(2026, 10, n); // Nov n, 2026 (UTC)
  const rows: CompactCallout[] = [
    { at: day(10), tailers: 100, pnl1h: 1000, pnl1d: 5000, peak: 20000 },
    { at: day(5), tailers: 50, pnl1h: null, pnl1d: -2000, peak: null }, // "reached —"
    { at: day(2), tailers: 10, pnl1h: -500, pnl1d: null, peak: 5000 },
    { at: day(1), tailers: 0, pnl1h: 0, pnl1d: 0, peak: 100000 },
  ];
  const R = (value: number | null, unit: string | null = "USD") => ({ value, unit });

  it("start = null takes every row and sums ignore nulls", () => {
    const a = aggregate(rows, null, R(1000));
    expect(a.callouts).toBe(4);
    expect(a.calloutsWithPeak).toBe(3);
    expect(a.tailers).toBe(160);
    expect(a.pnl1h).toBe(500);
    expect(a.pnl1d).toBe(3000);
    expect(a.peak).toBe(125000);
    expect(a.rewards).toBe(1000);
    expect(a.rewardsUnit).toBe("USD");
    expect(a.rewardsToPeak).toBeCloseTo(1000 / 125000, 12);
  });

  it("filters by start inclusively (at >= start)", () => {
    expect(aggregate(rows, day(5), R(null)).callouts).toBe(2); // Nov 5 and Nov 10
    expect(aggregate(rows, day(5) + 1, R(null)).callouts).toBe(1); // Nov 10 only
    const a = aggregate(rows, day(2), R(null));
    expect(a.callouts).toBe(3);
    expect(a.calloutsWithPeak).toBe(2);
    expect(a.tailers).toBe(160);
    expect(a.pnl1h).toBe(500);
    expect(a.pnl1d).toBe(3000);
    expect(a.peak).toBe(25000);
    expect(a.peakMedian).toBe(20000);
  });

  it("an empty window yields zeros and null median / ratio", () => {
    const a = aggregate(rows, day(11), R(1000));
    expect(a).toEqual({
      callouts: 0, calloutsWithPeak: 0, tailers: 0, pnl1h: 0, pnl1d: 0, peak: 0,
      peakMedian: null, rewards: 1000, rewardsUnit: "USD", rewardsToPeak: null,
    });
  });

  it("median is sorted[floor(n/2)]: middle for odd n, upper-middle for even n", () => {
    const mk = (peaks: (number | null)[]): CompactCallout[] => peaks.map((p, i) => ({ at: day(1) + i, tailers: 1, pnl1h: null, pnl1d: null, peak: p }));
    expect(aggregate(mk([50, 5, 20]), null, R(null)).peakMedian).toBe(20);
    expect(aggregate(mk([100, 5, 50, 20]), null, R(null)).peakMedian).toBe(50); // not the 35 average
    expect(aggregate(mk([-5000, 2000, 100]), null, R(null)).peakMedian).toBe(100); // numeric, not lexical, sort
    expect(aggregate(mk([null, 7000, null]), null, R(null)).peakMedian).toBe(7000); // nulls excluded
    expect(aggregate(mk([null, null]), null, R(null)).peakMedian).toBeNull();
  });

  it("calloutsWithPeak counts rows whose peak is not null (a zero counts, 'reached —' does not)", () => {
    const a = aggregate([
      { at: day(1), tailers: 1, pnl1h: null, pnl1d: null, peak: 0 },
      { at: day(2), tailers: 1, pnl1h: null, pnl1d: null, peak: null },
    ], null, R(null));
    expect(a.callouts).toBe(2);
    expect(a.calloutsWithPeak).toBe(1);
  });

  it("rewardsToPeak is null when rewards are null or the peak sum is <= 0", () => {
    const neg: CompactCallout[] = [{ at: day(1), tailers: 1, pnl1h: null, pnl1d: null, peak: -1000 }];
    const noPeak: CompactCallout[] = [{ at: day(1), tailers: 1, pnl1h: null, pnl1d: null, peak: null }];
    expect(aggregate(rows, null, R(null)).rewardsToPeak).toBeNull();
    expect(aggregate(neg, null, R(500)).rewardsToPeak).toBeNull();
    expect(aggregate(noPeak, null, R(500)).rewardsToPeak).toBeNull();
    expect(aggregate([], null, R(500)).rewardsToPeak).toBeNull();
    expect(aggregate(rows, null, R(0)).rewardsToPeak).toBe(0); // zero rewards is a real ratio
    expect(aggregate(rows, null, R(250000)).rewardsToPeak).toBe(2);
  });
});

describe("rewardsViewForWindow", () => {
  it("maps rolling windows to the leaderboard view of the same length, everything else to all-time", () => {
    expect(rewardsViewForWindow({ id: "1d", label: "", days: 1 })).toBe("daily");
    expect(rewardsViewForWindow({ id: "7d", label: "", days: 7 })).toBe("weekly");
    expect(rewardsViewForWindow({ id: "30d", label: "", days: 30 })).toBe("monthly");
    expect(rewardsViewForWindow({ id: "14d", label: "", days: 14 })).toBe("all");
    expect(rewardsViewForWindow({ id: "since", label: "", since: "2026-10-12" })).toBe("all");
    expect(rewardsViewForWindow({ id: "all", label: "" })).toBe("all");
  });
});

describe("windowStart", () => {
  const now = T("2026-11-04T18:30:00Z");
  it("rolling windows count back from now", () => {
    expect(windowStart({ id: "7d", label: "", days: 7 }, now)).toBe(now.getTime() - 7 * 86400e3);
    expect(windowStart({ id: "30d", label: "", days: 30 }, now)).toBe(Date.parse("2026-10-05T18:30:00Z"));
  });
  it("since windows start at UTC midnight of the given date", () => {
    expect(windowStart({ id: "since", label: "", since: "2026-10-12" }, now)).toBe(Date.UTC(2026, 9, 12));
  });
  it("all-time has no start", () => {
    expect(windowStart({ id: "all", label: "" }, now)).toBeNull();
  });
});
