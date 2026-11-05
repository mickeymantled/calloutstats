# Callout Check

Build "Callout Check", a public website that shows, per pump.fun KOL, what pump.fun itself reports for their callouts: number of callouts, tailers, 1h tailer PNL, 1d tailer PNL, and peak ("reached") tailer PNL, summed over a selectable window. Purpose: let anyone verify viral "copy-trader PNL" graphics against pump.fun's own numbers. Daily refresh, no login required for viewers.

## Context on the data

- Source: `pump.fun/profile/<handle>`, the Stats modal, Callouts tab. Each callout row renders text like `270 tailers · 1h +$2K · 1d +$9K · reached +$114K` plus a multiplier like `51x` and `$39.3K → $2.01M MC`. `reached —` means no peak recorded. Values use K/M suffixes and can be negative.
- Header of the modal shows totals: Callouts, Tailers, Tail volume.
- `pump.fun/leaderboard`, "Top rewards" tab, lists KOL handle and Callout Rewards earnings with daily / weekly / monthly / all-time views.
- There is no documented API. `pump.fun` and `frontend-api-v3.pump.fun` sit behind a Cloudflare challenge and reject plain HTTP clients. A real browser session works.
- A working DOM scraper for the Callouts modal already exists in `./pumpfun_callout_check.js` (console script). Port its parsing logic (regexes, K/M parsing, row dedup, scroll-until-stable) into the scraper. Do not rewrite the parsing from scratch.

## Architecture

### 1. Scraper

Runs on my Mac Mini. Node + Playwright, headed Chromium with a persistent `userDataDir` so a one-time manual login and Cloudflare pass carries over. First run opens a window and waits for me to log in and press Enter in the terminal.

- Step A: scrape the Top rewards leaderboard (all-time and 30d views) to get the KOL handle list and reward totals. Store every handle seen.
- Step B: for each handle, open the profile, open Stats > Callouts, sort by newest if that option exists, scroll until no new rows appear, parse every row, store each callout with the scrape timestamp. Keep a history: never overwrite a previous day's row for the same callout, append a new snapshot so peak and 1d values can be tracked over time.
- Also capture the three header totals (Callouts, Tailers, Tail volume).
- While scraping, log any XHR/fetch URLs the page makes to `*.pump.fun` that return JSON containing `tailers` or `callout`. Write them to `data/discovered_endpoints.json` with the response shape (keys only, no values). If a JSON endpoint is found that returns the same data, add a second data path that calls it directly from the logged-in browser context via `page.evaluate(fetch)` instead of DOM scraping, keep DOM scraping as fallback, and tell me.
- Rate limit: 2 to 4 seconds between profiles, randomized. Retry a profile up to 3 times on parse failure, then mark it failed in the run log and continue. Never crash the whole run on one profile.
- Config file `config.json`: handles to include beyond the leaderboard, handles to exclude, window options, scrape interval.
- Scheduling: a launchd plist I can load that runs the scraper daily at 06:00 Pacific, plus `npm run scrape` for manual runs.

### 2. Storage

SQLite via `better-sqlite3`. Tables: `kols`, `callouts` (one row per callout, keyed by handle + token name + callout age at first sight converted to an absolute date), `callout_snapshots` (per scrape values), `reward_snapshots`, `runs`. After each run export a static JSON bundle to `site/public/data/` (latest per-KOL totals, per-KOL callout detail, run metadata, discovered gaps).

### 3. Site

Next.js, static export, deployed to Vercel from the exported JSON. The Mac Mini commits and pushes data after each run; set up `npm run publish` that does git add data, commit with timestamp, push. Dark theme, mobile first.

Pages:

- `/` : table of all KOLs. Columns: handle (with avatar if available), callouts, tailers, 1h PNL sum, 1d PNL sum, peak PNL sum, median peak, callout rewards (from leaderboard), rewards-to-peak ratio. Window selector: 7d, 30d, since a custom date (default Oct 12 2026), all. Sortable columns. Sticky "last updated" with the run timestamp and how many profiles succeeded / failed.
- `/kol/<handle>` : every callout as a row with token, date, tailers, 1h, 1d, peak, multiplier, entry MC → peak MC, and a sparkline of how the peak sum has grown over snapshots.
- `/compare` : paste a handle and a claimed PNL number (for checking circulating graphics), returns pump.fun's reported 1h / 1d / peak totals next to the claimed figure.
- `/methodology` : plain-English explanation. State clearly: all figures are what pump.fun displays; 1h and 1d are tailer PNL at those marks; peak is the best point reached and is an upper bound, not realized profit; we do not compute on-chain PNL; pump.fun has changed its scoring and historical data may not match current rules; sums of peaks across callouts overstate what any single tailer could have made.
- Every number links to the pump.fun profile it came from.
- An embeddable widget route `/embed/<handle>` that renders a compact card with the 1h / 1d / peak totals and "last updated", usable in an iframe.
- OG image per KOL page so links unfurl on X with the numbers.

### 4. Quality

- TypeScript throughout. Unit tests for the parser using fixture strings copied from real rows, including negative values, `reached —`, K and M suffixes, and rows missing a multiplier.
- A `npm run verify <handle>` command that scrapes one profile and prints the parsed table so I can eyeball it against the site before trusting a run.
- README covering first-run login, scheduling, publishing, and how to add handles.

## Order of work

Start by reading `pumpfun_callout_check.js`, then scaffold the repo, then build the scraper and get a single-profile verify working against `pump.fun/profile/mickeymantled` before touching the site. Ask me before changing the data model after the first successful run.
