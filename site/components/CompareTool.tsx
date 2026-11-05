"use client";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./Avatar";
import { Money, Num } from "./Money";
import { WindowPicker } from "./WindowPicker";
import { fmtInt, fmtMoney, fmtRatio, parseMoneyInput, signClass } from "@/lib/format";
import { kolHref } from "@/lib/site";
import type { Kol, Meta } from "@/lib/types";
import { fetchKols, useCalloutsBundle } from "@/lib/useCallouts";
import { CUSTOM_ID, defaultSel, isCustom, needsBundle, resolveAgg, selLabel, type WindowSel } from "@/lib/windows";

const normalizeHandle = (h: string) => h.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?pump\.fun\/profile\//i, "").replace(/[/?#].*$/, "");

/** Case-insensitive lookup on kols.json. */
function findKol(kols: Kol[], raw: string): Kol | null {
  const h = normalizeHandle(raw);
  if (!h) return null;
  return kols.find((k) => k.handle === h) ?? kols.find((k) => k.handle.toLowerCase() === h.toLowerCase()) ?? null;
}

export function CompareTool({ meta }: { meta: Meta }) {
  const [handle, setHandle] = useState("");
  const [claimedRaw, setClaimedRaw] = useState("");
  const [sel, setSel] = useState<WindowSel>(() => defaultSel(meta));
  const [kols, setKols] = useState<Kol[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ handle: string; claimed: string } | null>(null);

  // Prefill from ?handle=&claimed=&w=&since= so results can be shared.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const h = p.get("handle") ?? "", c = p.get("claimed") ?? "", w = p.get("w"), s = p.get("since");
    if (h) setHandle(h);
    if (c) setClaimedRaw(c);
    if (w === CUSTOM_ID && s) setSel({ id: CUSTOM_ID, since: s });
    else if (w && meta.windows.some((x) => x.id === w)) setSel({ id: w });
    if (h) setSubmitted({ handle: h, claimed: c });
  }, [meta]);

  useEffect(() => {
    fetchKols().then(setKols, (e) => setLoadError(String(e?.message ?? e)));
  }, []);

  const kol = useMemo(() => (kols && submitted ? findKol(kols, submitted.handle) : null), [kols, submitted]);
  const { bundle, error: bundleError, loading } = useCalloutsBundle(!!kol && needsBundle(sel, kol ? [kol] : []));
  const agg = kol ? resolveAgg(kol, sel, meta, bundle) : null;
  const claimed = submitted ? parseMoneyInput(submitted.claimed) : null;

  const suggestions = useMemo(() => {
    if (!kols || !submitted || kol) return [];
    const h = normalizeHandle(submitted.handle).toLowerCase();
    if (!h) return [];
    return kols.filter((k) => k.handle.toLowerCase().includes(h) || (k.displayName ?? "").toLowerCase().includes(h)).slice(0, 8);
  }, [kols, submitted, kol]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const next = { handle: handle.trim(), claimed: claimedRaw.trim() };
    setSubmitted(next);
    const p = new URLSearchParams();
    if (next.handle) p.set("handle", normalizeHandle(next.handle));
    if (next.claimed) p.set("claimed", next.claimed);
    p.set("w", sel.id);
    if (isCustom(sel)) p.set("since", sel.since!);
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
  };

  return (
    <>
      <form className="panel" onSubmit={submit}>
        <div className="form-row">
          <label className="field">
            <span>pump.fun handle</span>
            <input type="text" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="e.g. mickeymantled or a pump.fun/profile URL" autoComplete="off" spellCheck={false} />
          </label>
          <label className="field">
            <span>Claimed PNL (optional)</span>
            <input type="text" inputMode="decimal" value={claimedRaw} onChange={(e) => setClaimedRaw(e.target.value)} placeholder="e.g. $1.2M or 250K" autoComplete="off" />
          </label>
          <button className="btn" type="submit">Check</button>
        </div>
        <div style={{ marginTop: 10 }}>
          <WindowPicker meta={meta} sel={sel} onChange={setSel} compact />
        </div>
      </form>

      {loadError && <div className="notice bad" style={{ marginTop: 12 }}>Could not load kols.json: {loadError}</div>}

      {submitted && kols && !kol && (
        <div className="panel" style={{ marginTop: 12 }}>
          <p className="muted" style={{ margin: 0 }}>
            {normalizeHandle(submitted.handle) ? <>No tracked KOL matches <b className="mono">{normalizeHandle(submitted.handle)}</b>. Only handles the scraper has visited appear here (leaderboard top rewards plus config.json includeHandles).</> : "Enter a handle."}
          </p>
          {suggestions.length > 0 && (
            <ul className="plain" style={{ marginTop: 8 }}>
              {suggestions.map((k) => (
                <li key={k.handle}>
                  <button type="button" className="btn ghost" style={{ padding: "4px 10px", minHeight: 0 }} onClick={() => { setHandle(k.handle); setSubmitted({ handle: k.handle, claimed: submitted.claimed }); }}>
                    {k.handle}
                  </button>
                  {k.displayName && k.displayName !== k.handle && <span className="muted small"> · {k.displayName}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {submitted && !kols && !loadError && <p className="muted" style={{ marginTop: 12 }}>Loading KOL data…</p>}

      {kol && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="kol-head">
            <Avatar handle={kol.handle} avatarUrl={kol.avatarUrl} size="lg" />
            <div className="title">
              <h2 style={{ margin: 0 }}><a href={kolHref(kol.handle)} style={{ color: "inherit" }}>{kol.displayName || kol.handle}</a></h2>
              <div className="meta">
                <span className="mono">@{kol.handle}</span>
                <a href={kol.profileUrl} target="_blank" rel="noopener noreferrer">pump.fun profile ↗</a>
                <a href={kolHref(kol.handle)}>all callouts →</a>
              </div>
            </div>
          </div>

          <p className="muted small" style={{ marginTop: 10 }}>
            Window: <b>{selLabel(sel, meta)}</b>{isCustom(sel) && " (computed in your browser)"}{loading && " · computing…"}
            {bundleError && <span className="neg"> · {bundleError}</span>}
          </p>

          {agg === undefined && <p className="muted">Computing…</p>}
          {agg === null && <p className="muted">No figures for this window.</p>}
          {agg && (
            <>
              <div className="tbl-wrap">
                <table className="tbl" style={{ minWidth: 0 }}>
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>pump.fun reports</th>
                      {claimed !== null && <th>Claimed</th>}
                      {claimed !== null && <th>Claimed ÷ reported</th>}
                    </tr>
                  </thead>
                  <tbody>
                    <CompareRow label="1h PNL sum" help="Tailer PNL at the 1h mark, summed over callouts" value={agg.pnl1h} claimed={claimed} href={kol.profileUrl} />
                    <CompareRow label="1d PNL sum" help="Tailer PNL at the 1d mark, summed over callouts" value={agg.pnl1d} claimed={claimed} href={kol.profileUrl} />
                    <CompareRow label="Peak PNL sum" help="Best point reached per callout, summed. Upper bound, not realized" value={agg.peak} claimed={claimed} href={kol.profileUrl} />
                    <tr>
                      <td className="muted">Callouts / tailers</td>
                      <td><Num text={`${fmtInt(agg.callouts)} / ${fmtInt(agg.tailers)}`} href={kol.profileUrl} /></td>
                      {claimed !== null && <td className="na">—</td>}
                      {claimed !== null && <td className="na">—</td>}
                    </tr>
                  </tbody>
                </table>
              </div>
              {claimed !== null && <Verdict claimed={claimed} agg={agg} />}
              {claimed === null && submitted?.claimed && <p className="notice" style={{ marginTop: 10 }}>Could not read “{submitted?.claimed}” as a dollar figure. Try formats like <code>$1.2M</code>, <code>250K</code>, <code>-3,000</code>.</p>}
            </>
          )}
        </div>
      )}
    </>
  );
}

function CompareRow({ label, help, value, claimed, href }: { label: string; help: string; value: number; claimed: number | null; href: string }) {
  const ratio = claimed !== null && value !== 0 ? claimed / value : null;
  return (
    <tr>
      <td className="muted" title={help}>{label}</td>
      <td><Money value={value} href={href} /></td>
      {claimed !== null && <td className={signClass(claimed)}>{fmtMoney(claimed, { sign: true })}</td>}
      {claimed !== null && (
        <td title={value === 0 ? "pump.fun reports zero for this metric" : "Claimed figure divided by pump.fun's figure"}>
          {ratio === null ? <span className="na">—</span> : <span className={ratio > 1 ? "neg" : "pos"}>{fmtRatio(ratio)}</span>}
        </td>
      )}
    </tr>
  );
}

function Verdict({ claimed, agg }: { claimed: number; agg: { pnl1h: number; pnl1d: number; peak: number } }) {
  const c = fmtMoney(claimed, { sign: true });
  let text: React.ReactNode;
  if (claimed <= 0) {
    text = <>The claimed figure {c} is not a profit, so there is nothing to inflate. pump.fun shows 1d <b>{fmtMoney(agg.pnl1d, { sign: true })}</b> and peak <b>{fmtMoney(agg.peak, { sign: true })}</b> for this window.</>;
  } else if (agg.peak <= 0) {
    text = <>pump.fun reports no positive peak PNL for this window (peak sum <b>{fmtMoney(agg.peak, { sign: true })}</b>), so the claimed <b>{c}</b> has no support in pump.fun's own numbers.</>;
  } else if (claimed > agg.peak) {
    text = <>The claimed <b>{c}</b> is <b className="neg">{fmtRatio(claimed / agg.peak)}</b> pump.fun's peak total of <b>{fmtMoney(agg.peak, { sign: true })}</b>. Even if every tailer sold at the exact top of every callout, pump.fun's numbers do not reach the claim.</>;
  } else if (claimed > Math.max(agg.pnl1d, 0)) {
    text = <>The claimed <b>{c}</b> sits between the 1d total (<b>{fmtMoney(agg.pnl1d, { sign: true })}</b>) and the peak total (<b>{fmtMoney(agg.peak, { sign: true })}</b>). It is only reachable by selling at or near the top of every callout; the peak sum is an upper bound, not realized profit.</>;
  } else {
    text = <>The claimed <b>{c}</b> is within pump.fun's 1d total of <b>{fmtMoney(agg.pnl1d, { sign: true })}</b> for this window ({fmtRatio(claimed / Math.max(agg.pnl1d, 1e-9))} of it). Note this is the sum across all tailers, not any single wallet.</>;
  }
  return <p className="verdict notice info" style={{ marginTop: 12 }}>{text}</p>;
}
