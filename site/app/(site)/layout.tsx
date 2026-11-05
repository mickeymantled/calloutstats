import { UpdatedBar } from "@/components/UpdatedBar";
import { loadMeta } from "@/lib/data";
import { SITE_NAME } from "@/lib/site";

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const meta = loadMeta();
  return (
    <>
      <header className="site-header">
        <div className="container">
          <a className="brand" href="/"><span className="dot" aria-hidden="true" />{SITE_NAME}</a>
          <nav className="nav" aria-label="Main">
            <a href="/">KOLs</a>
            <a href="/compare">Compare</a>
            <a href="/methodology">Methodology</a>
          </nav>
        </div>
      </header>
      <UpdatedBar meta={meta} />
      <main className="container">{children}</main>
      <footer className="site-footer">
        <div className="container">
          <span>All figures are what pump.fun displays on each profile's Stats › Callouts tab. Peak PNL is an upper bound, not realized profit.</span>
          <a href="/methodology">How to read these numbers</a>
          <a href="https://pump.fun/leaderboard" target="_blank" rel="noopener noreferrer">pump.fun leaderboard ↗</a>
        </div>
      </footer>
    </>
  );
}
