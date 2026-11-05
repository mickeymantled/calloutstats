import type { Metadata } from "next";
import { loadMeta } from "@/lib/data";

export const metadata: Metadata = {
  title: "Methodology",
  description: "How Callout Check collects pump.fun KOL callout figures, what each number means, and what it does not mean.",
  alternates: { canonical: "/methodology" },
};

export default function MethodologyPage() {
  const meta = loadMeta();
  return (
    <article className="prose">
      <h1>Methodology</h1>
      <p>
        Callout Check republishes numbers that pump.fun already shows on each KOL's profile. We add nothing but arithmetic: we sum
        the per-callout figures over a time window and let you compare them with claims circulating elsewhere.
      </p>

      <div className="key">
        <h2 style={{ marginTop: 0 }}>Read this before quoting a number</h2>
        <ul>
          <li><b>All figures are what pump.fun displays.</b> Every value on this site is read from the Stats › Callouts tab of a pump.fun profile or from the pump.fun leaderboard. We do not independently verify them.</li>
          <li><b>1h and 1d are tailer PNL at those marks.</b> They are pump.fun's figure for the combined profit or loss of the wallets that tailed (copied) the callout, measured one hour and one day after it.</li>
          <li><b>Peak is the best point reached and is an upper bound, not realized profit.</b> pump.fun's “reached” value is the highest tailer PNL seen at any moment. Nobody is guaranteed to have sold there.</li>
          <li><b>We do not compute on-chain PNL.</b> We do not look at wallets, trades or token prices. If pump.fun's number is wrong, ours is wrong in the same way.</li>
          <li><b>pump.fun has changed its scoring</b> and may change it again. Historical callouts may have been scored under different rules than current ones, so old and new figures are not strictly comparable.</li>
          <li><b>Sums of peaks across callouts overstate what any single tailer could have made.</b> Each peak happened at a different moment, to a different set of wallets. Adding them up describes the whole crowd at its luckiest, not one person.</li>
          <li><b>Callout dates are estimated</b> from pump.fun's “x days ago” labels, so a callout's date can be off by about a day. Window boundaries (7 days, 30 days, a since-date) inherit that uncertainty.</li>
        </ul>
      </div>

      <h2>Where the data comes from</h2>
      <p>
        A scraper runs once a day in a real logged-in browser. It opens <code>pump.fun/leaderboard</code> (Top rewards, all-time and
        monthly views) to find KOL handles and their callout rewards, then visits each profile, opens Stats › Callouts, scrolls until no
        new rows appear and parses each row: token, age, tailers, 1h, 1d, reached (peak), multiplier and entry → peak market cap. The
        handles in the leaderboard plus a small configured list are the only profiles tracked.
      </p>
      <p>
        Nothing is overwritten: every day's reading of every callout is kept as a snapshot. The KOL pages show the latest snapshot per
        callout and a sparkline of how the summed peak has moved across runs.
      </p>

      <h2>What each column means</h2>
      <ul>
        <li><b>Callouts</b>: number of callout rows pump.fun shows whose estimated date falls inside the window. When some rows show “reached —” (no peak recorded) the count with a peak is shown underneath.</li>
        <li><b>Tailers</b>: sum of the tailer counts across those callouts. The same wallet tailing ten callouts counts ten times.</li>
        <li><b>1h PNL / 1d PNL</b>: sum of pump.fun's 1h and 1d tailer PNL across the callouts. Negative values are real losses as pump.fun reports them.</li>
        <li><b>Peak PNL</b>: sum of pump.fun's “reached” values. Callouts showing “—” contribute nothing.</li>
        <li><b>Median peak</b>: the middle value of the per-callout peaks (callouts without a peak excluded). For an even count we take the upper-middle value.</li>
        <li><b>Rewards</b>: callout rewards from the pump.fun leaderboard, in the unit pump.fun shows. The 7-day window uses the weekly view, 30 days the monthly view, and other windows the all-time view; where a view is missing we fall back to all-time, and “—” means no leaderboard entry at all.</li>
        <li><b>Rewards / peak</b>: rewards divided by the peak PNL sum; a rough sense of how much the KOL earned relative to the best case for their tailers.</li>
      </ul>

      <h2>Windows</h2>
      <p>
        Available windows: {meta.windows.map((w, i) => <span key={w.id}>{i > 0 && ", "}<b>{w.label}</b></span>)}. Rolling windows are
        measured back from the time of the last scrape. The custom since-date on the KOL table is computed in your browser from the same
        per-callout data, with exactly the same arithmetic.
      </p>

      <h2>Known limitations</h2>
      <ul>
        <li>Profiles that fail to load are retried up to three times, then skipped for that run; the sticky bar shows how many succeeded and failed, and the home page lists gaps.</li>
        <li>Callouts are matched day to day by token, estimated date and entry market cap. A re-callout of the same token on the same day with a similar entry cap can be merged.</li>
        <li>A callout that pump.fun removes from a profile stays in our history with its last seen values.</li>
        <li>We only see what a logged-in pump.fun session renders. If the page layout changes, a run can fail or parse incorrectly; the fixture badge, run status and gaps list are there to make that visible.</li>
      </ul>

      <h2>Using the numbers</h2>
      <p>
        Use the <a href="/compare">compare tool</a> to put a claimed PNL next to pump.fun's 1h, 1d and peak totals. A claim above the peak
        total is not supported by pump.fun's own data. A claim between the 1d and peak totals requires everyone to have sold at the top.
        Each KOL page also offers an embeddable card (<code>/embed/&lt;handle&gt;</code>) with the same three totals.
      </p>
    </article>
  );
}
