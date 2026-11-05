import type { Metadata } from "next";
import { CompareTool } from "@/components/CompareTool";
import { loadMeta } from "@/lib/data";

export const metadata: Metadata = {
  title: "Compare a claimed PNL",
  description: "Paste a pump.fun KOL handle and a claimed copy-trader PNL figure; see pump.fun's own 1h / 1d / peak totals next to it.",
  alternates: { canonical: "/compare" },
};

export default function ComparePage() {
  const meta = loadMeta();
  return (
    <>
      <h1>Check a claimed PNL</h1>
      <p className="muted" style={{ maxWidth: 760 }}>
        Saw a graphic claiming a KOL's tailers made a fortune? Enter the handle and the number. We show what pump.fun itself reports
        for that KOL's callouts in the window, and how the claim compares to the 1h, 1d and peak totals.
      </p>
      <CompareTool meta={meta} />
      <p className="muted small" style={{ marginTop: 16 }}>
        The peak total is the sum of the best point each callout reached; it is an upper bound on what all tailers combined could have made, not what anyone realized.
        A claim above it is not supported by pump.fun's numbers. A claim below the 1d total is at least plausible as a <em>group</em> figure. <a href="/methodology">Methodology</a>.
      </p>
    </>
  );
}
