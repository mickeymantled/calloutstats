# Callout Check

Callout Check scrapes what pump.fun itself reports for each KOL's callouts (number of
callouts, tailers, 1h and 1d tailer PNL, peak "reached" PNL, plus Callout Rewards from the
leaderboard), keeps every day's figures as append-only snapshots in SQLite, and exports a
static JSON bundle that the public site builds from. Purpose: let anyone check a viral
"copy-trader PNL" graphic against pump.fun's own numbers, summed over a selectable window.
The scraper runs daily on a Mac (headed Chromium, persistent login); the site is a static
Next.js export deployed to Vercel.

## Status (2026-11-04): unattended scraping is blocked by pump.fun's bot protection

Everything in this repo works end to end except the unattended part. Tested on 2026-11-04:

- Playwright-driven Chromium (bundled build) and Playwright-driven Google Chrome 157, headed,
  persistent profile, logged in, with a valid `cf_clearance` cookie obtained by hand in a plain
  Chrome window: Cloudflare re-issues the interactive "Verify you are human" check on every
  automated launch. A human clicking the checkbox inside the automated window does clear it
  for that session, so interactive runs work.
- Plain HTTPS clients against `frontend-api-v3.pump.fun` and `advanced-api-v2.pump.fun`,
  identified as this project: HTTP 403 with `cf-mitigated: challenge`.

This project does not try to hide automation from Cloudflare (no stealth flags, no
fingerprint spoofing). Until one of the following changes, the launchd job will fail fast
and log why.

1. Ask pump.fun for data access (an export or an API key). This is the only sustainable
   unattended path; `src/scraper/api.ts` is the place to plug it in.
2. Interactive runs: `npm run scrape` opens Chrome, you click the checkbox once, the run
   continues through every profile and publishes.
3. Manual: run `pumpfun_callout_check.js` in your own browser per profile (a CSV import
   command is not built yet).

`config.json` currently points at Google Chrome (`browser.channel: "chrome"`, profile in
`data/browser-profile-chrome/`); set `channel` to `null` to go back to the bundled Chromium.

## Prerequisites

- Node 22 (`node --version`); `engines` allows >= 20 but 22 is what this runs on.
- `npm install` at the repo root (scraper, SQLite, tests).
- `npx playwright install chromium` once, for the bundled browser. To reuse an installed
  Google Chrome instead, set `browser.channel` to `"chrome"` in `config.json`.
- For the site: `npm --prefix site install`.

## First run: log in once

```sh
npm run login
```

Opens a headed Chromium with a persistent profile at `data/browser-profile/` on pump.fun.
Complete the Cloudflare check and log in in that window, then press Enter in the terminal.
Cookies live in the profile directory, so every later scrape reuses the session. Repeat
this whenever pump.fun logs you out (the scraper logs a warning when no saved session is
found and continues anonymously, which usually still works for public profiles).

## Verify a single profile

```sh
npm run verify mickeymantled            # eyeball only
npm run verify mickeymantled -- --save  # also store the result and re-export the bundle
npm run verify mickeymantled -- --debug # verbose logging
```

Opens `pump.fun/profile/<handle>`, Stats -> Callouts, scrolls until no new rows appear and
prints: profile URL, display name, avatar, the three header totals (Callouts, Tailers, Tail
volume), rows parsed and scroll steps, a table with one line per callout (token, age,
tailers, 1h, 1d, peak, multiplier, entry -> peak MC) and a summary object (totals, callouts
with a peak, median peak). The raw modal text is written to `data/raw/<handle>.txt` for
building parser fixtures. `--save` writes the rows to SQLite as a one-profile run and
re-exports `site/public/data/`. Any JSON endpoints seen during the visit are listed at the
end (see Endpoint discovery).

## Full scrape

```sh
npm run scrape                               # leaderboard + every known handle
npm run scrape -- --handle a,b               # only these handles, skips the leaderboard
npm run scrape -- --skip-leaderboard         # known handles + includeHandles only
npm run scrape -- --limit 20                 # cap profiles this run (0 / omitted = config)
npm run scrape -- --debug                    # verbose logging
npm run scrape -- --no-interactive           # never wait on stdin (what launchd uses)
```

Step A scrapes the leaderboard "Top rewards" tab for each view in `leaderboardViews`,
stores every handle seen (`kols`) and the reward totals (`reward_snapshots`). Step B visits
every handle (leaderboard + `includeHandles` + anything seen before, minus
`excludeHandles`) with a randomized 2-4 s pause, retries a profile up to
`maxRetriesPerProfile` times, marks it failed and moves on. Run metadata is written to
`data/runs/<started-at>.json` and the JSON bundle is re-exported. Exit code 2 means the
whole run failed; partial failures still exit 0 and show up in `gaps.json`.
`npm run export` re-exports the bundle from the current database without scraping.

### Adding or excluding handles

Edit `config.json`: `includeHandles` are scraped even when they are not on the leaderboard,
`excludeHandles` are skipped everywhere. Handles may be written as `name`, `@name` or a
profile URL; they are normalized. Handles once seen stay in the database and are
re-scraped on every run until excluded.

## config.json

| field | meaning |
| --- | --- |
| `includeHandles` / `excludeHandles` | extra handles to scrape / handles to skip |
| `windows` | window definitions for the site: `{ id, label, days }` rolling, `{ id, label, since: "YYYY-MM-DD" }` fixed start (UTC midnight), or neither for all-time |
| `defaultWindow` | `id` of the window the site shows first |
| `leaderboardViews` | leaderboard views to scrape: `all`, `monthly`, `weekly`, `daily` |
| `delayBetweenProfilesMs` | `[min, max]` random pause between profiles |
| `maxRetriesPerProfile` | parse-failure retries before a profile is marked failed |
| `maxProfilesPerRun` | cap per run, `0` = no cap (`--limit` overrides) |
| `browser.channel` | `null` = bundled Chromium, `"chrome"` = installed Google Chrome |
| `browser.headless` | keep `false`; Cloudflare and the persistent login expect a headed browser |
| `browser.userDataDir` | persistent profile dir, default `data/browser-profile` |
| `browser.timezoneId` | timezone the browser reports, default `America/Los_Angeles` |
| `export.siteDataDir` | where the JSON bundle goes, default `site/public/data` |

The rewards column for a window uses the leaderboard view of the same length (7 days ->
`weekly`, 30 -> `monthly`, 1 -> `daily`) and falls back to `all` when that view is not
scraped. With the default `["all", "monthly"]` the 7-day window shows all-time rewards;
add `"weekly"` if you want it exact.

## Scheduling with launchd

`launchd/com.calloutcheck.scrape.plist` runs
`cd "<repo>" && npm run scrape -- --no-interactive && npm run publish` every day at
06:00 **local time**. launchd's `StartCalendarInterval` follows the Mac's time zone; this
Mac is set to Pacific, so that is 06:00 Pacific, DST included. Install it with:

```sh
scripts/install-launchd.sh            # render, copy to ~/Library/LaunchAgents, load
scripts/install-launchd.sh --dry-run  # print the rendered plist, change nothing
scripts/install-launchd.sh --uninstall
```

The script fills in the repo's absolute path (spaces are fine) and the directory of your
`node` binary, then runs `launchctl bootout` (ignored if not loaded) and
`launchctl bootstrap gui/$(id -u)`. Useful commands it prints:

```sh
launchctl kickstart -k gui/$(id -u)/com.calloutcheck.scrape   # run it now
launchctl print gui/$(id -u)/com.calloutcheck.scrape          # status / last exit code
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.calloutcheck.scrape.plist
```

Requirements and gotchas:

- The scraper drives a headed browser, so the Mac must have a user **logged in to a GUI
  session** when the job fires. The screen may be locked; a logged-out Mac cannot run it.
- If the Mac is asleep at 06:00 the job runs on wake; if it is off, that day is skipped.
  `sudo pmset repeat wakeorpoweron MTWRFSU 05:55:00` wakes it in time.
- Output goes to `data/logs/launchd.out.log` / `launchd.err.log` (plus the dated
  `data/logs/YYYY-MM-DD.log` the scraper writes itself).
- Re-run `scripts/install-launchd.sh` after moving the repo or changing node versions;
  the plist has the paths baked in.

## Publishing

```sh
npm run publish
```

`scripts/publish.sh` runs `git add data site/public/data`, commits as
`data: 2026-11-04T06:00Z run` (UTC timestamp) only if something is staged, then
`git push` to the current branch's upstream. It prints a message and exits 0 when there is
nothing to commit or no upstream/remote is set; it exits non-zero only on a real git error
(for example a rejected push: `git pull --rebase` and push again). Only those two paths are
committed, so anything else you have staged is left alone.

What gets committed: `site/public/data/` (the bundle: `meta.json`, `kols.json`,
`callouts.json`, `gaps.json`, `kol/<handle>.json`), `data/runs/*.json` and
`data/discovered_endpoints.json`. The `.gitignore` keeps `data/callouts.sqlite*`,
`data/browser-profile/`, `data/raw/` and `data/logs/` out of git: **the database and the
browser session never leave this machine. Back up `data/callouts.sqlite` yourself** (it is
the only copy of the snapshot history; the JSON bundle can always be regenerated from it).

Before the first scheduled run, link the branch once: `git push -u origin main`.

## The site

`site/` is a Next.js app with `output: "export"`, built entirely from the JSON in
`site/public/data/` at build time (no server, no database access). On Vercel set the
project's **root directory to `site`**; every data push triggers a rebuild with the fresh
bundle. Locally: `npm run site:dev` and `npm run site:build` (output in `site/out/`).
Routes: `/` (all KOLs, window selector), `/kol/<handle>`, `/compare`, `/methodology`,
`/embed/<handle>` (iframe card).

## Data model

SQLite at `data/callouts.sqlite` (WAL mode), schema in `src/db.ts`:

- `kols`: one row per handle (display name, avatar, profile URL, source = leaderboard |
  config, first/last seen).
- `runs`: one row per scrape run (status running | ok | partial | failed, profile counts).
- `callouts`: one row per callout. Natural key = `handle` + `token` + estimated callout
  date. The date comes from the "3d ago" text at first sight converted to an absolute UTC
  time (`callout_at`, `callout_date`, `age_precision`); `age_known = 0` marks a row whose
  age could not be parsed, in which case the scrape time is a placeholder that gets
  refined when a dated row arrives.
- `callout_snapshots`: one row per callout per run (tailers, 1h, 1d, peak, multiplier,
  entry/peak MC, raw text). Append-only, never updated, so peak and 1d can be tracked over
  time.
- `reward_snapshots`: leaderboard rank and rewards per handle, view and run.
- `profile_snapshots`: per handle and run, the header totals (Callouts, Tailers, Tail
  volume), rows parsed and ok | failed with the error.

Matching rule (`matchOrCreateCallout`): same handle and token, callout date within +/- 1 day
(the "x d ago" text rounds, so the computed date can drift by a day between runs), and a
compatible entry market cap: within 2 % counts as the same callout, further apart means the
token was called out again; a missing MC on either side never rules a match out and is
filled in when seen. The export takes the latest snapshot per callout for the site's totals
and ships every snapshot for the per-callout sparklines.

## Endpoint discovery

While scraping, every XHR/fetch to `*.pump.fun` whose JSON response mentions `tailers` or
`callout` is recorded in `data/discovered_endpoints.json`: method, URL template (query
values replaced by `<v>`), hit count and the response **shape as keys only, never values**.
Entries flagged `looksLikeCallouts` return an array of objects with tailer/callout keys and
are candidates for a direct JSON data path (fetched from the logged-in browser context,
DOM scraping stays the fallback). `gaps.json` in the bundle lists the discovered endpoints
along with failed, stale and zero-callout profiles.

## Tests and checks

```sh
npm test            # vitest: parser fixtures, matching rules, window aggregation
npm run typecheck   # tsc --noEmit
```

## Caveats

- Every figure is what pump.fun displays, parsed from the rendered modal. We do not
  compute on-chain PNL, and pump.fun has changed its scoring over time, so older callouts
  may not follow current rules.
- 1h and 1d are tailer PNL at those marks. **Peak ("reached") is an upper bound**: the best
  point the position ever hit, not realized profit, and sums of peaks across callouts
  overstate what any single tailer could have made.
- Callout dates are estimated from "x ago" text (`age_precision` says how coarse), so a
  callout can sit a day off the real time and move between adjacent windows.
- Values are rounded as pump.fun rounds them (`$2.01M`, `+$9K`); `reached —` is stored as
  null and excluded from the peak count and median.
- Leaderboard rewards are read as displayed (USD or SOL, see `rewards_unit`); the
  rewards-to-peak ratio is only meaningful when the peak sum is positive.
