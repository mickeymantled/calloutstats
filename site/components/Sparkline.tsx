import { fmtMoney, fmtDateUTC } from "@/lib/format";
import type { HistoryPoint } from "@/lib/types";

interface Props {
  history: HistoryPoint[];
  width?: number;
  height?: number;
}

/** Inline SVG of how the summed peak PNL has grown across scrape runs (history[].peakSum). */
export function Sparkline({ history, width = 320, height = 64 }: Props) {
  const pts = history.filter((h) => Number.isFinite(h.peakSum));
  if (pts.length === 0) return <span className="muted">No snapshots yet.</span>;

  const pad = 6;
  const w = width, h = height;
  const ys = pts.map((p) => p.peakSum);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (min === max) { min -= 1; max += 1; }
  const x = (i: number) => (pts.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (pts.length - 1));
  const y = (v: number) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.peakSum).toFixed(1)}`).join(" ");
  const area = `${d} L${x(pts.length - 1).toFixed(1)},${(h - pad).toFixed(1)} L${x(0).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const last = pts[pts.length - 1];
  const first = pts[0];
  const up = last.peakSum >= first.peakSum;
  const stroke = up ? "var(--pos)" : "var(--neg)";
  const zeroY = min < 0 && max > 0 ? y(0) : null;

  return (
    <div className="spark">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Peak PNL sum over ${pts.length} snapshots, from ${fmtMoney(first.peakSum)} to ${fmtMoney(last.peakSum)}`}>
        <title>{`Peak sum over ${pts.length} run${pts.length === 1 ? "" : "s"}: ${fmtMoney(first.peakSum, { sign: true })} → ${fmtMoney(last.peakSum, { sign: true })}`}</title>
        {zeroY !== null && <line x1={pad} x2={w - pad} y1={zeroY} y2={zeroY} stroke="var(--border-2)" strokeDasharray="3 3" />}
        {pts.length > 1 && <path d={area} fill={stroke} opacity="0.12" />}
        {pts.length > 1 && <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {pts.map((p, i) => (
          <circle key={p.runId} cx={x(i)} cy={y(p.peakSum)} r={i === pts.length - 1 ? 3.5 : 2.2} fill={stroke}>
            <title>{`Run ${p.runId} · ${fmtDateUTC(p.at)} · peak sum ${fmtMoney(p.peakSum, { sign: true })} · ${p.callouts} callouts`}</title>
          </circle>
        ))}
      </svg>
      <div className="legend">
        <div><b>{pts.length}</b> snapshot{pts.length === 1 ? "" : "s"} · {fmtDateUTC(first.at)} → {fmtDateUTC(last.at)}</div>
        <div>Peak sum <b className={up ? "pos" : "neg"}>{fmtMoney(first.peakSum, { sign: true })} → {fmtMoney(last.peakSum, { sign: true })}</b></div>
      </div>
    </div>
  );
}
