# Collector protocol (Chrome extension <-> local collector service)

> **Status (2026-11-04):** the extension client in `extension/` implements this protocol.
> Basis: pump.fun has no data API and its team told the project owner to collect the
> figures the way user-side tools do, from the user's own browser session. The extension
> never interacts with a verification page. The console script `pumpfun_callout_check.js`
> remains as a manual route: it POSTs to `POST /capture` when the collector is running and
> otherwise copies its capture to the clipboard for `npm run import -- --clipboard`.
>
> ### `POST /capture` (manual captures)
> Body: the capture object the console script produces
> (`{ version: 1, handle, url, scrapedAt, displayName, avatarUrl, dialogText, modalText, blocks }`).
> The collector parses it exactly like `src/cli/import.ts`, stores it as its own run
> (`notes: "capture: <handle>"`, profile source `import`), re-exports the bundle and answers
> `{ "ok": true, "runId": n, "rows": n, "header": {...} }`. Preflight responses include
> `Access-Control-Allow-Private-Network: true` so a page on https://pump.fun may call it.

Why this exists: pump.fun's Cloudflare configuration re-challenges any WebDriver/CDP-driven
browser and 403s plain HTTP clients, but a normal Chrome session with a user-installed
extension is just a user browsing. So collection runs inside the user's real Chrome
(profile `data/browser-profile-chrome`, already logged in), driven by a Manifest V3
extension in `extension/`, and the Node side becomes a small local HTTP service
(`npm run collector`, `src/collector/server.ts`) that owns SQLite, parsing, export and
publish. The extension never parses rows; it ships text and the collector runs
`src/parser.ts` on it, so there is one parser.

The collector listens on `http://127.0.0.1:47831` only. All bodies are JSON. The
collector sets `Access-Control-Allow-Origin: *` on every response (localhost only).

## Scheduling

The extension polls `GET /due` every minute (chrome.alarms). It starts a run when `due`
is true. The collector decides due-ness: a run is due when a run was explicitly
requested (`POST /request-run`), or when `config.json` `scrapeIntervalHours` have passed
since the last finished run **and** local time is at/after `config.json`
`scheduleHourLocal` (default 6) on a day with no finished run yet. The extension popup
has a "Run now" button that calls `POST /request-run` then runs immediately.

## Endpoints

### `GET /status`
```json
{ "ok": true, "version": "0.1.0", "running": { "runId": 12, "startedAt": "...", "handle": "x" } | null,
  "lastRun": { "id": 11, "startedAt": "...", "finishedAt": "...", "status": "ok|partial|failed",
               "profilesTotal": 40, "profilesOk": 39, "profilesFailed": 1 } | null,
  "due": false, "requested": null | { "handles": ["a"], "skipLeaderboard": true, "requestedAt": "..." },
  "kols": 40, "collectorHost": "Brians-Mac-mini.local" }
```

### `GET /due`
```json
{ "due": true, "reason": "requested" | "interval" | "", "request": null | { "handles": [...], "skipLeaderboard": true } }
```

### `POST /request-run`
Body (all optional): `{ "handles": ["mickeymantled"], "skipLeaderboard": true, "limit": 5, "debug": true }`.
Stores one pending request (replaces any earlier one). Response `{ "ok": true }`.
`npm run scrape:request -- [--handle a,b] [--skip-leaderboard] [--limit N]` calls this.

### `POST /run/start`
Body: `{ "source": "extension", "extensionVersion": "0.1.0", "request": <the request object from /due, or null> }`.
Creates a `runs` row (status running), clears the pending request, and returns the plan:
```json
{ "runId": 12, "leaderboardViews": ["all", "monthly"], "skipLeaderboard": false,
  "delayMs": [2000, 4000], "maxRetriesPerProfile": 3, "debug": false,
  "handles": ["mickeymantled"] }
```
`handles` is non-empty only when the request named handles (then `skipLeaderboard`
is forced true). Otherwise the extension scrapes the leaderboard first and then asks
`GET /run/:id/handles`. If a run is already `running` and its `startedAt` is less than
3 hours old, respond `409 { "error": "run in progress", "runId": n }`; older stale
running rows are marked `failed` ("abandoned") and a new run starts.

### `POST /run/:id/leaderboard`
Body: `{ "view": "all", "entries": [ { "handle": "x", "displayName": "X", "avatarUrl": "https://...", "rank": 1,
"rewards": 1234.5, "unit": "USD" | "SOL" | null, "raw": "row text (<=300 chars)" } ], "rawText": "page innerText (optional, <=200 KB)" }`.
Collector upserts `kols` (source leaderboard), inserts `reward_snapshots`, writes
`data/raw/leaderboard-<view>.txt` when rawText is given. Response `{ "ok": true, "handles": n }`.
The extension may call this once per view, in order; a parse problem for one view
must not stop the others.

### `GET /run/:id/handles`
Returns `{ "handles": [...] }`: leaderboard-ranked handles seen in this run first, then
`config.includeHandles`, then every other known handle, minus `excludeHandles`, capped
by the request's `limit` or `config.maxProfilesPerRun` (0 = no cap).

### `POST /run/:id/profile`
One call per profile attempt (the extension retries up to `maxRetriesPerProfile` only
when the collector answers `"status": "retry"`).
Body:
```json
{ "handle": "mickeymantled", "url": "https://pump.fun/profile/mickeymantled",
  "attempt": 1, "status": "ok" | "failed" | "notfound",
  "error": "optional message when failed/notfound",
  "displayName": "mickeymantled", "avatarUrl": "https://..." | null,
  "modalText": "innerText of the callouts list element after scrolling (<=2 MB)",
  "blocks": ["unique 16-line blocks around each row seen during scrolling, joined with \n", ...],
  "dialogText": "innerText of the whole stats dialog (header totals live here)",
  "state": "rows" | "empty" | "unknown",
  "range": "1M" | "All" | null,
  "rowsSeen": 220,
  "iterations": 37, "durationMs": 14000,
  "endpoints": ["https://frontend-api-v3.pump.fun/...?x=1", ...],
  "screenshotDataUrl": null }
```
Collector: parses `modalText` and every block with `harvest()` into one row map,
`parseHeaderTotals` on `dialogText`, saves `data/raw/<handle>.txt` (dialogText +
modalText), records endpoint URLs (query values redacted) into
`data/discovered_endpoints.json`, and:
- rows > 0, or state "empty", or header callouts === 0 -> `storeProfileResult`, respond
  `{ "status": "ok", "rows": n, "header": { "callouts": 2, "tailers": 282, "tailVolume": 45000 }, "zeroCallouts": false }`
- rows == 0 and not empty -> if attempt < maxRetriesPerProfile respond `{ "status": "retry", "reason": "no rows parsed" }`,
  else insert a failed `profile_snapshots` row and respond `{ "status": "failed", "reason": ... }`.
- body status "failed" -> same retry/fail rule; "notfound" -> failed snapshot, no retry.

### `POST /run/:id/finish`
Body: `{ "total": 40, "ok": 39, "failed": 1, "aborted": false, "failures": [ { "handle": "x", "error": "..." } ] }`.
Collector: `finishRun` (status ok / partial / failed), writes `data/runs/<ts>.json`,
runs `exportBundle`, then spawns `npm run publish` (non-blocking, logged). Response
`{ "ok": true, "status": "ok", "exported": { "kols": 40, "callouts": 1234 } }`.

### `POST /log`
Body `{ "level": "info" | "warn" | "error", "message": "...", "runId": 12 }` -> appended to
`data/logs/<date>.log` with an `[ext]` prefix. Response `{ "ok": true }`.

## Content-script contract (what the extension must do on a profile page)

Port of `pumpfun_callout_check.js` and `src/scraper/profile.ts`, in plain JS:
1. Wait for `document.readyState === "complete"` plus 800 ms. If body text matches
   /profile not found|user not found|page not found/i and contains no "Stats", report
   `notfound`.
2. Click the Stats control (button/tab/link whose trimmed text is exactly "Stats" or
   "View stats", case-insensitive; wait <=10 s for it to render). Wait until body text
   matches /tail volume|callouts/i (<=15 s).
3. Inside `[role=dialog]` (last one) click the tab/button whose text is exactly
   "Callouts". Wait 900 ms.
3b. Time range: the modal defaults to "LAST ROUND". Click the range tab "All" / "All time"
   if present, else "1M" (the widest offered on 2026-11-04), unless it is already
   `aria-selected`; wait until the header's callout count changes (<=8 s) + 1.2 s. Report
   the label as `range`.
4. Sort: if a control with text /recent|newest/i exists, make sure it is selected; a
   `<select>` with such an option counts. Best effort.
5. Wait (<=15 s) until body text has /\btailers?\b/ and /reached/ ("rows"), or
   /no callouts|no callouts in this period|nothing to show/i ("empty").
6. Locate the list element exactly as the console script does: the first `div,section`
   whose innerText includes "Callouts" and /tailers/, length < 500000, and none of whose
   children also does. `dialog` = its closest `[role=dialog]` or itself. `scroller` = the
   descendant of `dialog` with overflow-y auto|scroll and the largest scrollHeight
   (> clientHeight + 10), else the list element.
7. Loop (max 400, stop after 6 consecutive iterations with no new rows): take
   `list.innerText`, split lines, for every line matching the row-start regex
   `^\d[\d,]*\s*tailers?\b` (case-insensitive) add the block
   `lines[i-7 .. i+8].join("\n")` to a Set; then
   `scroller.scrollTop = scroller.scrollHeight`; click any visible button with text
   /load more|show more/i; wait 600 ms. The list loads 40 more rows per scroll and, on
   2026-11-04, stopped at 220 rows although the header counted 473 (see "Real layout").
8. Report `modalText` (final `list.innerText`), `blocks` (the Set), `dialogText`
   (`dialog.innerText`), `range`, `rowsSeen` (row-start lines in modalText), `endpoints`
   (URLs from `performance.getEntriesByType("resource")` with initiatorType
   fetch/xmlhttprequest and hostname containing "pump"), `displayName` (og:title or first
   h1), `avatarUrl` (og:image or an img whose alt contains the handle). Press Escape at
   the end.

Real layout (pump.fun/profile/mickeymantled, 2026-11-04). The modal's innerText is one
item per line; the parser's `normalizeLines()` folds it back into the console script's
single-line form, so captures from either era parse the same way:

```
Stats / @mickeymantled / Callouts / Streaks / Volume / LAST ROUND / TODAY / 1W / 1M
Callouts / 13 / 7 new · 6 earlier / Tailers / 1,899 / Top 0.25% of 5,173 / Tail volume / $120K / Top 0.25% of 5,173
Callouts / Recent
X / · / 19h ago / 1.1x / $152K / $178K MC / 50 tailers · 1h / −$1K / · 1d / — / · reached / +$1K
...
Performance / Reached 2x+ / 69.2% / 13 calls / ... / Outcome spread / 1.0x / ... / Updated Nov 4, 2026, 6:57 PM
```

Negative values use U+2212 MINUS SIGN; "—" means no value (also for 1d on callouts younger
than a day); the multiplier and "entry → peak MC" sit above the stats line. Header
tailers (1,899) is not the sum of the rows' tailers (2,367): pump.fun counts unique
tailers there. `/leaderboard` answered with a Cloudflare interstitial ("Just a moment...",
HTTP 403) even in a browser that loads profiles without one; background.js waits up to
45 s for it to clear on its own and otherwise reports the page as failed.

Leaderboard page: click "Top rewards"; for each view click the control whose text
matches all-time (/all[\s-]?time|^all$/i), monthly (/month/i), weekly (/week/i),
daily (/day|daily|24h/i); wait 1500 ms; scroll `window` to the bottom until the number of
`a[href*="/profile/"]` stops growing (max 60 loops, 500 ms); for each anchor climb up to 8
ancestors until the ancestor's innerText contains an amount (`$1.2K` or `12 SOL`) and the
ancestor contains at most one profile anchor; report handle (from the href), anchor text,
first img src, rank (leading integer in the row text), the first `$` amount or SOL amount,
and the row text (<=300 chars).

## Extension runtime notes
- Run in a dedicated normal window (`chrome.windows.create`, `focused: false`,
  width 1100 x height 900) so the tab is visible and not timer-throttled; reuse that
  window's single tab for every page; close the window at the end of the run.
- Inject with `chrome.scripting.executeScript` after each navigation completes; no
  declarative content scripts.
- Between profiles wait a random `delayMs[0]..delayMs[1]`.
- Everything the background does is reported through `POST /log` so the collector's
  log is the single place to look.
- `chrome.storage.local` keeps: collectorUrl (default http://127.0.0.1:47831),
  lastRunSummary, lastError, enabled flag.
