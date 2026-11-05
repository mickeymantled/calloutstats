# Callout Check

Callout Check scrapes what pump.fun itself reports for each KOL's callouts (number of
callouts, tailers, 1h and 1d tailer PNL, peak "reached" PNL, plus Callout Rewards from the
leaderboard), keeps every day's figures as append-only snapshots in SQLite, and exports a
static JSON bundle that the public site builds from. Purpose: let anyone check a viral
"copy-trader PNL" graphic against pump.fun's own numbers, summed over a selectable window.
The scraper runs daily on a Mac (headed Chromium, persistent login); the site is a static
Next.js export deployed to Vercel.

## How data is collected (status 2026-11-04)

pump.fun's Cloudflare configuration re-challenges any WebDriver/CDP-driven browser on every
launch (tested with Playwright + bundled Chromium and Playwright + Google Chrome 157, logged
in, with a valid `cf_clearance`), and answers plain HTTPS clients with 403
`cf-mitigated: challenge`. pump.fun has no data API. Their team told the project owner to
collect the figures the way user-side tools such as notrandom.fun do: from the user's own
browser session. So the unattended path is:

- **`extension/`**: a Chrome extension loaded into the dedicated, logged-in Chrome profile
  (`data/browser-profile-chrome/`). Once a day it opens each profile in a side window,
  does what the console script does (Stats -> Callouts -> scroll to the end) and hands the
  raw text to the collector. It never touches a verification page; if one appears the
  profile is reported as failed. See `extension/README.md` for the one-time install.
- **Collector** (`npm run collector`, `src/collector/`): an always-on local service on
  127.0.0.1:47831 that owns scheduling, parsing (the same parser as everything else),
  SQLite, export and publish. `launchd/` keeps it and the Chrome profile running at login.

Other routes that still work: manual captures with the console script (next section), and
the Playwright scraper for interactive runs (`npm run scrape`, you click the checkbox once).
Nothing in this repo hides automation from Cloudflare or spoofs a browser.

What the first real runs (2026-11-04) showed, and what the code now does about it:

- The profile button reads **View stats**; the modal opens on the **LAST ROUND** range and
  offers TODAY / 1W / 1M. The extension switches to the widest range (All if it ever
  appears, else 1M) and reports which one it used.
- Rows render as a stack of flex items, so the modal text has one value per line with a
  Unicode minus sign. `src/parser.ts` (`normalizeLines`) folds that back into the
  single-line layout the console script expected; `src/parser.realrows.test.ts` pins the
  real text.
- **pump.fun rate-limits the callout list.** The modal fetches
  `frontend-api-v3.pump.fun/callout/list/<wallet>?limit=20&sortBy=TIMESTAMP&sortOrder=DESC&pageToken=…&window=monthly`
  (recorded in `data/discovered_endpoints.json` by the extension), and after about five
  pages in a row it answers HTTP 429 for a few minutes; the modal then shows "Could not
  load callout history right now", and every further scroll is another refused request
  that keeps the limit alive. So the extension scrolls briskly while rows arrive, leaves
  the page alone for 150 s once the loader stalls, gives up after 8 minutes without a new
  row, and allows 25 minutes per profile; the collector spaces retries 30-60 s × attempt
  apart and profiles 15-30 s apart (`delayBetweenProfilesMs`). A run over 15 busy
  profiles takes a few hours, which is fine for the 06:00 job. The spec's second data
  path (calling that JSON endpoint from the logged-in browser instead of scrolling,
  which would cut the requests five-fold) is not built yet: it was blocked by the
  assistant's auto-mode policy during this session and needs a session run without it.
- Callouts from before pump.fun began tracking tailers (mid-October 2026) show no tailer
  line at all: for mickeymantled the 1M header counted 473 callouts, 331 of which carry
  tailer stats. Only those are stored; the collector logs the two counts.
- **`/leaderboard` is behind a Cloudflare interstitial** even for a browser session that
  loads profiles without one. The extension waits up to 45 s for it to clear by itself and
  never interacts with it; until it clears, runs use the handles from `config.json` and
  the rewards column stays empty.

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

## Manual captures: console script + `npm run import`

This is the route that works today without automating pump.fun. You run the original
console script in your own browser; it never leaves your session.

1. Open `pump.fun/profile/<handle>` in your browser, click **Stats**, then the **Callouts** tab.
2. Open DevTools (Cmd-Opt-J), paste the whole of `pumpfun_callout_check.js`, press Enter.
   It scrolls the list to the end, prints the parsed table, totals and a CSV, and builds a
   JSON capture (raw modal text, header text, page metadata; no numbers are parsed in the
   browser, the importer re-parses with the shared parser).
3. If `npm run collector` is running on this machine the capture is stored immediately
   (`POST http://127.0.0.1:47831/capture`) and the site bundle is re-exported. Otherwise the
   capture is copied to the clipboard; then:

```sh
npm run import -- --clipboard                 # store what is on the clipboard
# or keep files around:
mkdir -p data/captures && pbpaste > data/captures/mickeymantled.json
npm run import data/captures/*.json           # several captures become one run
```

Each import is a run: callouts are matched to existing ones (handle + token + estimated
date, entry MC), a new snapshot is appended, `profile_snapshots` records the header totals
with `source = import`, and `site/public/data/` is re-exported. `npm run publish` then
commits and pushes. The capture's `scrapedAt` (when you ran the script) is used as the
snapshot time, so importing later is fine.

## The collector service

```sh
npm run collector                       # 127.0.0.1:47831, logs to data/logs/<date>.log
npm run scrape:request                  # ask for a full run (leaderboard + every known handle)
npm run scrape:request -- --handle a,b  # only these handles, no leaderboard
npm run scrape:request -- --limit 20    # cap this run
curl -s 127.0.0.1:47831/status          # what it is doing, last run, due-ness
```

The collector owns the run lifecycle for the extension (`docs/collector-protocol.md`):
`/due` decides when the daily run starts (`scheduleHourLocal`, `scrapeIntervalHours`, or an
explicit request), `/run/start` plans it, `/run/:id/profile` parses each profile's text with
the shared parser and stores it, `/run/:id/finish` exports the bundle and spawns
`npm run publish`. `POST /capture` accepts a manual capture from the console script. It
listens on 127.0.0.1 only. `collectorPort` in `config.json` changes the port (update the
extension popup's URL field too).

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

### Two keys the collector uses

| key | default | meaning |
|---|---|---|
| `scheduleHourLocal` | 6 | earliest local hour for the automatic daily run |
| `collectorPort` | 47831 | port of the local collector service |

## Scheduling with launchd

Daily collection is driven by the collector + extension pair, not by the Playwright scrape
job. `scripts/install-launchd.sh` installs three agents: `com.calloutcheck.collector`
(always on), `com.calloutcheck.chrome` (opens the dedicated Chrome profile at login) and the
optional `com.calloutcheck.scrape` (Playwright path). The run time is `scheduleHourLocal`
in `config.json` (default 6 = 06:00 local, Pacific on this Mac); the extension polls the
collector once a minute and starts the run when it is due.

### Playwright scrape job (optional)

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
  rewards-to-peak ratio is only meaningful when the peak sum is positive. As of 2026-11-04
  the leaderboard page is behind a Cloudflare interstitial, so rewards are empty until
  that changes.
- Callouts made before pump.fun tracked tailers (mid-October 2026) have no tailer line and
  are not stored, so pump.fun's header `callouts` count can exceed ours; the header
  `tailers` figure counts unique tailers, not the per-row sum. Totals on the site are sums
  over stored rows, and each row is as rounded as pump.fun shows it (`+$2K`), so a sum over
  hundreds of rows carries rounding noise of up to a few hundred dollars per row.
