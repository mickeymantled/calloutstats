import { fmtDateTimeUTC } from "@/lib/format";
import { kolHref } from "@/lib/site";
import type { Gaps } from "@/lib/types";

/** Known holes in the dataset, from gaps.json. */
export function GapsPanel({ gaps }: { gaps: Gaps }) {
  const n = gaps.failedProfiles.length + gaps.staleProfiles.length + gaps.noCallouts.length;
  if (n === 0) return null;
  return (
    <details className="panel" style={{ marginTop: 16 }}>
      <summary>Data gaps ({n})</summary>
      {gaps.failedProfiles.length > 0 && (
        <>
          <h3>Failed in the last run</h3>
          <ul className="plain small">
            {gaps.failedProfiles.map((f) => (
              <li key={f.handle}><a href={kolHref(f.handle)}>{f.handle}</a> <span className="muted">· {fmtDateTimeUTC(f.at)}{f.error ? ` · ${f.error}` : ""}</span></li>
            ))}
          </ul>
        </>
      )}
      {gaps.staleProfiles.length > 0 && (
        <>
          <h3>Stale (not scraped in 2+ days)</h3>
          <ul className="plain small">
            {gaps.staleProfiles.map((s) => (
              <li key={s.handle}><a href={kolHref(s.handle)}>{s.handle}</a> <span className="muted">· last {fmtDateTimeUTC(s.lastScrapedAt)}</span></li>
            ))}
          </ul>
        </>
      )}
      {gaps.noCallouts.length > 0 && (
        <>
          <h3>Scraped fine, no callouts found</h3>
          <p className="small muted">{gaps.noCallouts.map((h, i) => <span key={h}>{i > 0 && ", "}<a href={kolHref(h)}>{h}</a></span>)}</p>
        </>
      )}
    </details>
  );
}
