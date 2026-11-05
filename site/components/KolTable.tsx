"use client";
import { useMemo, useState } from "react";
import { Avatar } from "./Avatar";
import { Money, Num } from "./Money";
import { WindowPicker } from "./WindowPicker";
import { fmtInt, fmtPct, fmtRewards } from "@/lib/format";
import { kolHref } from "@/lib/site";
import type { Kol, Meta, WindowAgg } from "@/lib/types";
import { rewardsViewForWindow } from "@/lib/aggregate";
import { useCalloutsBundle } from "@/lib/useCallouts";
import { defaultSel, isCustom, needsBundle, resolveAgg, selLabel, selToDef, type WindowSel } from "@/lib/windows";

type SortKey = "handle" | "callouts" | "tailers" | "pnl1h" | "pnl1d" | "peak" | "peakMedian" | "rewards" | "rewardsToPeak";

const COLS: { key: SortKey; label: string; title: string }[] = [
  { key: "handle", label: "KOL", title: "pump.fun handle" },
  { key: "callouts", label: "Callouts", title: "Callouts in the window (and how many have a recorded peak)" },
  { key: "tailers", label: "Tailers", title: "Sum of tailers across callouts in the window" },
  { key: "pnl1h", label: "1h PNL", title: "Sum of tailer PNL at the 1h mark, as shown by pump.fun" },
  { key: "pnl1d", label: "1d PNL", title: "Sum of tailer PNL at the 1d mark, as shown by pump.fun" },
  { key: "peak", label: "Peak PNL", title: "Sum of 'reached' (peak) tailer PNL. An upper bound, not realized profit" },
  { key: "peakMedian", label: "Median peak", title: "Median of per-callout peaks (callouts without a peak excluded)" },
  { key: "rewards", label: "Rewards", title: "Callout rewards from the pump.fun leaderboard (view matched to the window)" },
  { key: "rewardsToPeak", label: "Rewards / peak", title: "Callout rewards divided by the peak PNL sum" },
];

interface Row { kol: Kol; agg: WindowAgg | null | undefined }

function sortValue(r: Row, key: SortKey): number | string | null {
  if (key === "handle") return (r.kol.displayName || r.kol.handle).toLowerCase();
  const a = r.agg;
  if (!a) return null;
  const v = a[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function KolTable({ kols, meta }: { kols: Kol[]; meta: Meta }) {
  const [sel, setSel] = useState<WindowSel>(() => defaultSel(meta));
  const [sortKey, setSortKey] = useState<SortKey>("peak");
  const [desc, setDesc] = useState(true);
  const [q, setQ] = useState("");
  const { bundle, error, loading } = useCalloutsBundle(needsBundle(sel, kols));

  const def = selToDef(sel, meta);
  const rewardsView = def ? rewardsViewForWindow(def) : "all";

  const rows = useMemo<Row[]>(() => {
    const now = new Date();
    const needle = q.trim().toLowerCase();
    return kols
      .filter((k) => !needle || k.handle.toLowerCase().includes(needle) || (k.displayName ?? "").toLowerCase().includes(needle))
      .map((kol) => ({ kol, agg: resolveAgg(kol, sel, meta, bundle, now) }))
      .sort((a, b) => {
        const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
        if (va === null && vb === null) return 0;
        if (va === null) return 1; // nulls last
        if (vb === null) return -1;
        const c = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) : (va as number) - (vb as number);
        return desc ? -c : c;
      });
  }, [kols, sel, meta, bundle, sortKey, desc, q]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) setDesc(!desc);
    else { setSortKey(key); setDesc(key !== "handle"); }
  };

  return (
    <>
      <div className="toolbar">
        <WindowPicker meta={meta} sel={sel} onChange={setSel} />
        <input className="grow" type="search" placeholder="Filter handles…" aria-label="Filter handles" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="muted small" style={{ margin: "0 0 8px" }}>
        {rows.length} of {kols.length} KOLs · window: <b>{selLabel(sel, meta)}</b>
        {isCustom(sel) && " · computed in your browser from callouts.json"}
        {loading && " · computing…"}
        {error && <span className="neg"> · could not load callouts.json ({error})</span>}
        {" · rewards view: "}{rewardsView}
      </p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} title={c.title} className={`sortable${c.key === "handle" ? " sticky-col" : ""}${sortKey === c.key ? " sorted" : ""}`} onClick={() => onSort(c.key)} aria-sort={sortKey === c.key ? (desc ? "descending" : "ascending") : "none"}>
                  {c.label} <span className="arrow">{sortKey === c.key ? (desc ? "▼" : "▲") : ""}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ kol, agg }) => {
              const href = kol.profileUrl;
              const failed = kol.lastStatus === "failed";
              if (agg === undefined) {
                return (
                  <tr key={kol.handle}>
                    <td className="sticky-col"><HandleCell kol={kol} failed={failed} /></td>
                    {COLS.slice(1).map((c) => <td key={c.key} className="na">…</td>)}
                  </tr>
                );
              }
              const peaksSub = agg && agg.calloutsWithPeak < agg.callouts ? `${agg.calloutsWithPeak} w/ peak` : null;
              return (
                <tr key={kol.handle}>
                  <td className="sticky-col"><HandleCell kol={kol} failed={failed} /></td>
                  <td>
                    <Num text={agg ? fmtInt(agg.callouts) : "—"} href={href} />
                    {peaksSub && <span className="cell-sub">{peaksSub}</span>}
                  </td>
                  <td><Num text={agg ? fmtInt(agg.tailers) : "—"} href={href} /></td>
                  <td><Money value={agg?.pnl1h ?? null} href={href} /></td>
                  <td><Money value={agg?.pnl1d ?? null} href={href} /></td>
                  <td><Money value={agg?.peak ?? null} href={href} /></td>
                  <td><Money value={agg?.peakMedian ?? null} href={href} /></td>
                  <td>
                    <Num text={agg ? fmtRewards(agg.rewards, agg.rewardsUnit) : "—"} href="https://pump.fun/leaderboard" title="Source: pump.fun leaderboard, Top rewards" />
                  </td>
                  <td><Num text={agg ? fmtPct(agg.rewardsToPeak) : "—"} href={href} title="Rewards ÷ peak PNL sum" /></td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={COLS.length} className="center muted" style={{ padding: 24 }}>No KOLs match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HandleCell({ kol, failed }: { kol: Kol; failed: boolean }) {
  const name = kol.displayName || kol.handle;
  return (
    <div className="handle-cell">
      <a href={kolHref(kol.handle)} aria-label={`Details for ${kol.handle}`}><Avatar handle={kol.handle} avatarUrl={kol.avatarUrl} /></a>
      <div style={{ minWidth: 0 }}>
        <a className="name" href={kolHref(kol.handle)}>{name}</a>
        <a className="ext" href={kol.profileUrl} target="_blank" rel="noopener noreferrer" title="Open on pump.fun">↗</a>
        {failed && <span className="badge bad" style={{ marginLeft: 6 }} title={kol.lastError ?? "Last scrape failed; showing the previous snapshot"}>stale</span>}
        {name !== kol.handle && <div className="sub">@{kol.handle}</div>}
      </div>
    </div>
  );
}
