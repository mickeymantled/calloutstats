# Callout Check — site

Static Next.js (App Router, `output: "export"`) front end for the pump.fun KOL callout data scraped by the tool at the repo root.

## Data

The site renders **only** the JSON bundle in `public/data/`, written by `src/export.ts` (`npm run export` / after each scrape at the repo root):

- `meta.json` run metadata, windows, counts
- `kols.json` per-KOL totals per window
- `callouts.json` compact per-callout rows (fetched in the browser for custom since-dates)
- `kol/<encoded handle>.json` per-KOL detail: every callout, snapshots, history
- `gaps.json` failed / stale / empty profiles

Pages are generated at build time from these files via `fs`; the window math for a custom start date runs client side with the same `aggregate()` logic (`lib/aggregate.ts` mirrors `src/export.ts`). The site builds with an empty `public/data/` (zero KOLs).

Fixture data for development, without scraping (refuses to overwrite real data):

```sh
# from the repo root
npx tsx scripts/make-fixture-data.ts   # writes site/public/data with "fixture": true
```

## Build

```sh
cd site
npm install
npm run build     # prebuild renders OG PNGs into public/og, then `next build` -> out/
npm run dev       # dev server on http://localhost:3000
```

OG images (one 1200x630 PNG per KOL plus `public/og/default.png`) are rendered by `scripts/build-og.mjs` with `next/og` before every build; `public/og/` is gitignored.

## Deploy (Vercel)

- Framework preset: **Next.js**, Root Directory: **`site`**. Build command `npm run build`, output `out` (auto-detected from `output: "export"`).
- Set `NEXT_PUBLIC_SITE_URL` (e.g. `https://calloutcheck.example`) so OG/canonical URLs are absolute; otherwise `VERCEL_PROJECT_PRODUCTION_URL` is used.
- Each push of `site/public/data/` (done by `npm run publish` on the scraper machine) triggers a rebuild.
- `/embed/<handle>` is meant for iframes; no X-Frame-Options / CSP headers are set.

## Routes

`/` KOL table · `/kol/<handle>` every callout + sparkline · `/compare` claimed-PNL check · `/methodology` · `/embed/<handle>` compact card
