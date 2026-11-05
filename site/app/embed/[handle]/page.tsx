import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Money } from "@/components/Money";
import { PLACEHOLDER_HANDLE, defaultWindowDef, findKol, loadMeta, staticHandleParams } from "@/lib/data";
import { fmtDateTimeUTC, fmtInt } from "@/lib/format";
import { kolHref, safeDecode } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return staticHandleParams();
}

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const kol = findKol(safeDecode(handle));
  return { title: `${kol?.displayName || safeDecode(handle)} · embed`, robots: { index: false, follow: true } };
}

/** Compact card for iframes: no nav, no chrome, 1h / 1d / peak totals plus last updated. */
export default async function EmbedPage({ params }: Params) {
  const { handle: raw } = await params;
  const kol = findKol(safeDecode(raw)) ?? findKol(raw);
  if (!kol) {
    if (safeDecode(raw) !== PLACEHOLDER_HANDLE) notFound();
    return <div className="embed-card muted">No KOL data yet.</div>;
  }
  const meta = loadMeta();
  const w = defaultWindowDef(meta);
  const agg = kol.windows[w.id] ?? null;
  const updated = meta.run?.finishedAt ?? meta.generatedAt;
  const href = kol.profileUrl;
  return (
    <div className="embed-card">
      <div className="top">
        <Avatar handle={kol.handle} avatarUrl={kol.avatarUrl} />
        <a className="name" href={href} target="_blank" rel="noopener noreferrer">{kol.displayName || kol.handle}</a>
        <span className="win" title={`Window: ${w.label}`}>{w.label}</span>
      </div>
      {agg ? (
        <div className="nums">
          <div><div className="label">1h PNL</div><div className="value"><Money value={agg.pnl1h} href={href} /></div></div>
          <div><div className="label">1d PNL</div><div className="value"><Money value={agg.pnl1d} href={href} /></div></div>
          <div><div className="label">Peak PNL</div><div className="value"><Money value={agg.peak} href={href} /></div></div>
        </div>
      ) : (
        <div className="muted">No callout data for this window.</div>
      )}
      <div className="foot">
        <span>{agg ? `${fmtInt(agg.callouts)} callouts · tailer PNL as shown by pump.fun` : "as shown by pump.fun"}</span>
        <span>updated {fmtDateTimeUTC(updated)} · <a href={kolHref(kol.handle)} target="_top">Callout Check</a></span>
      </div>
    </div>
  );
}
