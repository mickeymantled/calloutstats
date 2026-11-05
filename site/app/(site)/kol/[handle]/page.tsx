import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Money, Num } from "@/components/Money";
import { RelativeTime } from "@/components/RelativeTime";
import { Sparkline } from "@/components/Sparkline";
import { PLACEHOLDER_HANDLE, defaultWindowDef, loadMeta, resolveKol, staticHandleParams } from "@/lib/data";
import { fmtDateUTC, fmtInt, fmtMoney, fmtMult, fmtPct, fmtRewards } from "@/lib/format";
import { OG_SIZE, compareHref, embedHref, enc, kolHref, ogImageHref, siteUrl } from "@/lib/site";
import type { Callout } from "@/lib/types";

export const dynamicParams = false;

export function generateStaticParams() {
  return staticHandleParams();
}

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const kol = resolveKol(handle);
  if (!kol) return { title: handle === PLACEHOLDER_HANDLE ? "No data yet" : "KOL not found", robots: { index: false } };
  const meta = loadMeta();
  const w = defaultWindowDef(meta);
  const agg = kol.windows[w.id];
  const name = kol.displayName || kol.handle;
  const description = agg
    ? `${w.label}: ${agg.callouts} callouts · 1h ${fmtMoney(agg.pnl1h, { sign: true })} · 1d ${fmtMoney(agg.pnl1d, { sign: true })} · peak ${fmtMoney(agg.peak, { sign: true })} tailer PNL, as reported by pump.fun.`
    : `pump.fun callout stats for ${name}.`;
  const image = { url: ogImageHref(kol.handle), ...OG_SIZE, alt: `${name}: pump.fun callout stats` };
  return {
    title: `${name} (@${kol.handle})`,
    description,
    alternates: { canonical: kolHref(kol.handle) },
    openGraph: { title: `${name} · pump.fun callouts`, description, type: "profile", url: kolHref(kol.handle), images: [image] },
    twitter: { card: "summary_large_image", title: `${name} · pump.fun callouts`, description, images: [image.url] },
  };
}

const approx = (c: Callout) => !c.ageKnown || c.agePrecision === "day" || c.agePrecision === "week" || c.agePrecision === "month";

export default async function KolPage({ params }: Params) {
  const { handle } = await params;
  const kol = resolveKol(handle);
  if (!kol) {
    if (handle !== PLACEHOLDER_HANDLE) notFound();
    return (
      <div className="empty" style={{ marginTop: 16 }}>
        <p><b>No KOL data yet.</b></p>
        <p className="small">This placeholder exists only because the dataset is empty. Run the scraper and export, then rebuild.</p>
        <p><a href="/">← All KOLs</a></p>
      </div>
    );
  }
  const meta = loadMeta();
  const name = kol.displayName || kol.handle;
  const href = kol.profileUrl;
  const failed = kol.lastStatus === "failed";
  const embedUrl = new URL(embedHref(kol.handle), siteUrl()).toString();

  return (
    <>
      <p className="small"><a href="/">← All KOLs</a></p>
      <div className="kol-head">
        <Avatar handle={kol.handle} avatarUrl={kol.avatarUrl} size="lg" />
        <div className="title">
          <h1>{name}</h1>
          <div className="meta">
            <span className="mono">@{kol.handle}</span>
            <a href={href} target="_blank" rel="noopener noreferrer">pump.fun profile ↗</a>
            <span title="How this handle was found">source: {kol.source}</span>
            {kol.lastScrapedAt && <span>scraped <RelativeTime iso={kol.lastScrapedAt} /></span>}
            {kol.lastStatus && <span className={`badge ${failed ? "bad" : "ok"}`}>{kol.lastStatus}</span>}
          </div>
          {kol.header && (
            <div className="meta small">
              <span>pump.fun header totals:</span>
              <span>Callouts <Num text={fmtInt(kol.header.callouts)} href={href} /></span>
              <span>Tailers <Num text={fmtInt(kol.header.tailers)} href={href} /></span>
              <span>Tail volume <Money value={kol.header.tailVolume} href={href} sign={false} /></span>
            </div>
          )}
        </div>
        <div className="kol-actions">
          <a className="btn ghost" href={compareHref(kol.handle)}>Check a claim</a>
          <a className="btn ghost" href={embedHref(kol.handle)} target="_blank" rel="noopener noreferrer">Embed card ↗</a>
        </div>
      </div>

      {failed && (
        <p className="notice bad" style={{ marginTop: 12 }}>
          The last scrape of this profile failed{kol.lastError ? `: ${kol.lastError}` : ""}. Figures below are from the most recent successful snapshot of each callout.
        </p>
      )}

      <h2>Totals by window</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">Window</th><th>Callouts</th><th>Tailers</th><th>1h PNL</th><th>1d PNL</th><th>Peak PNL</th><th>Median peak</th><th>Rewards</th><th>Rewards / peak</th>
            </tr>
          </thead>
          <tbody>
            {meta.windows.map((w) => {
              const a = kol.windows[w.id];
              const isDefault = w.id === meta.defaultWindow;
              return (
                <tr key={w.id} style={isDefault ? { fontWeight: 600 } : undefined}>
                  <td className="sticky-col">{w.label}{isDefault && <span className="cell-sub">default</span>}</td>
                  <td><Num text={a ? fmtInt(a.callouts) : "—"} href={href} />{a && a.calloutsWithPeak < a.callouts && <span className="cell-sub">{a.calloutsWithPeak} w/ peak</span>}</td>
                  <td><Num text={a ? fmtInt(a.tailers) : "—"} href={href} /></td>
                  <td><Money value={a?.pnl1h ?? null} href={href} /></td>
                  <td><Money value={a?.pnl1d ?? null} href={href} /></td>
                  <td><Money value={a?.peak ?? null} href={href} /></td>
                  <td><Money value={a?.peakMedian ?? null} href={href} /></td>
                  <td><Num text={a ? fmtRewards(a.rewards, a.rewardsUnit) : "—"} href="https://pump.fun/leaderboard" title="Source: pump.fun leaderboard, Top rewards" /></td>
                  <td><Num text={a ? fmtPct(a.rewardsToPeak) : "—"} href={href} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Peak sum over snapshots</h2>
      <div className="panel">
        <Sparkline history={kol.history} />
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          Sum of “reached” across every callout seen in each scrape run. It grows as new callouts appear and as pump.fun raises a callout's peak; it is an upper bound, not realized profit.
        </p>
      </div>

      <h2>All callouts ({kol.callouts.length})</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky-col">Token</th><th>Date</th><th>Tailers</th><th>1h</th><th>1d</th><th>Peak</th><th>Mult</th><th>Entry → peak MC</th><th>Snaps</th>
            </tr>
          </thead>
          <tbody>
            {kol.callouts.map((c) => (
              <tr key={c.id}>
                <td className="sticky-col" style={{ fontWeight: 600, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={c.token}>{c.token}</td>
                <td title={`${c.calloutAt}${c.ageRaw ? ` · pump.fun showed "${c.ageRaw}"` : ""}${c.agePrecision ? ` · precision: ${c.agePrecision}` : ""}${c.ageKnown ? "" : " · age unknown, dated at first sight"}`}>
                  <Num text={`${approx(c) ? "≈ " : ""}${fmtDateUTC(c.calloutDate)}`} href={href} />
                  {c.ageRaw && <span className="cell-sub">{c.ageRaw}</span>}
                </td>
                <td><Num text={fmtInt(c.tailers)} href={href} /></td>
                <td><Money value={c.pnl1h} href={href} /></td>
                <td><Money value={c.pnl1d} href={href} /></td>
                <td><Money value={c.peak} href={href} title={c.peak === null ? "pump.fun shows “reached —”" : undefined} /></td>
                <td><Num text={fmtMult(c.mult)} href={href} /></td>
                <td title={c.mcRaw ?? undefined}>
                  <Money value={c.entryMc} href={href} sign={false} className="muted" /> <span className="faint">→</span> <Money value={c.peakMc} href={href} sign={false} className="muted" />
                </td>
                <td className="muted" title={c.snapshots.map((s) => `${fmtDateUTC(s.at)}: peak ${fmtMoney(s.peak, { sign: true })}`).join("\n")}>{c.snapshots.length}</td>
              </tr>
            ))}
            {kol.callouts.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 24 }}>No callouts recorded for this profile.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">“≈” marks dates estimated from pump.fun's “x days ago” label, which can be off by about a day. Every figure links to the pump.fun profile it was read from.</p>

      <h2>Embed</h2>
      <div className="panel">
        <p className="small muted" style={{ marginTop: 0 }}>A compact card with the 1h / 1d / peak totals and the last-updated time. Works in any iframe.</p>
        <pre className="code">{`<iframe src="${embedUrl}" width="420" height="150" style="border:0" loading="lazy" title="pump.fun callout stats for @${kol.handle}"></iframe>`}</pre>
        <p className="small" style={{ marginBottom: 0 }}><a href={`/kol/${enc(kol.handle)}`}>Permalink</a> · <a href={embedHref(kol.handle)} target="_blank" rel="noopener noreferrer">Open card</a></p>
      </div>
    </>
  );
}
