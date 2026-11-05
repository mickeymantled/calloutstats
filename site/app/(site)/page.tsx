import type { Metadata } from "next";
import { GapsPanel } from "@/components/GapsPanel";
import { KolTable } from "@/components/KolTable";
import { loadGaps, loadKols, loadMeta } from "@/lib/data";
import { SITE_DESCRIPTION } from "@/lib/site";

export const metadata: Metadata = {
  title: "pump.fun KOL callout stats",
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
};

export default function HomePage() {
  const meta = loadMeta();
  const kols = loadKols();
  const gaps = loadGaps();
  return (
    <>
      <h1>KOL callouts, as pump.fun reports them</h1>
      <p className="muted" style={{ maxWidth: 760 }}>
        Per KOL: callouts, tailers and the 1h / 1d / peak tailer PNL that pump.fun shows, summed over the selected window.
        Every figure links to the pump.fun profile it was read from. <a href="/methodology">Read the methodology</a> before quoting anything.
      </p>
      {kols.length === 0 ? (
        <div className="empty" style={{ marginTop: 16 }}>
          <p><b>No KOL data yet.</b></p>
          <p className="small">Run the scraper (<code>npm run scrape</code>) at the repo root and export the bundle to <code>site/public/data/</code>, then rebuild the site.</p>
        </div>
      ) : (
        <KolTable kols={kols} meta={meta} />
      )}
      <GapsPanel gaps={gaps} />
    </>
  );
}
