# Callout Check collector (Chrome extension)

Collects pump.fun callout stats from **this browser's own logged-in session** and hands the
raw text to the local collector service (`npm run collector`, port 47831), which parses it
with the shared parser, stores it in SQLite, exports the site bundle and publishes.

Why an extension: pump.fun's Cloudflare setup re-challenges any WebDriver/CDP-driven
browser, but a normal Chrome profile with a user-installed extension is just a user
browsing. pump.fun's team told the project owner this is an acceptable way to collect the
figures. The extension never interacts with a verification page: if one shows up it
reports that profile as failed and moves on.

## Files

| file | role |
|---|---|
| `manifest.json` | MV3 manifest: alarms, storage, scripting, tabs; host access to pump.fun and 127.0.0.1:47831 |
| `background.js` | service worker: polls `GET /due` every minute, runs the leaderboard + profile loop, retries, delays, resumes after a worker restart, reports everything to `POST /log` |
| `content-profile.js` | on a profile page: Stats -> Callouts -> sort Recent -> scroll to the end -> return modal text, row blocks, dialog text, metadata, API URLs seen |
| `content-leaderboard.js` | on /leaderboard: Top rewards -> each view -> scroll -> one entry per profile link |
| `popup.html`, `popup.js` | status, Run now / Run one, enabled toggle, collector URL |

The protocol between the extension and the collector is `../docs/collector-protocol.md`.

## Install (one time, in the dedicated profile)

1. Start the collector on this Mac: `npm run collector` (or install the launchd agent,
   see the root README).
2. Open the dedicated Chrome profile (the one you logged in to pump.fun with):
   `scripts/install-launchd.sh` installs an agent that opens it at login, or run
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="$PWD/data/browser-profile-chrome"`.
3. In that Chrome, open `chrome://extensions`, turn on **Developer mode** (top right),
   click **Load unpacked**, select this `extension/` folder.
4. Click the extension's icon: the popup should say the collector is **online**. Type
   `mickeymantled` into the handle box and press **Run one**. A separate window opens,
   visits the profile, scrolls the callouts, closes. The collector log
   (`data/logs/<date>.log`) shows the parsed row count; `npm run verify`-style output is
   in the collector's terminal.
5. Leave Chrome running. The extension polls the collector once a minute and starts the
   daily run when the collector says it is due (`scheduleHourLocal` in `config.json`,
   default 06:00 local, Pacific on this Mac).

Chrome shows a "Disable developer mode extensions" bubble on each start for unpacked
extensions; dismiss it, the extension stays loaded.

## Manual runs

- Popup **Run now**: leaderboard + every known handle.
- Popup **Run one**: only the typed handle, no leaderboard.
- From a terminal: `npm run scrape:request -- --handle a,b` (picked up within a minute).

## Troubleshooting

- Popup says offline: the collector is not running or the URL field is wrong.
- A run never starts: check the **enabled** box, and `GET http://127.0.0.1:47831/due`.
- Profiles fail with "verification page shown": open pump.fun in that Chrome profile by
  hand and complete the check once; the session persists.
- Profiles fail with "Stats control not found" or "blocked by a dialog": pump.fun changed
  the page, or a first-visit dialog is up in that profile; open the page by hand, dismiss
  it, retry. The raw text of every attempt is in `data/raw/<handle>.txt`.
- Service worker logs: `chrome://extensions` -> the extension -> "service worker" link.
