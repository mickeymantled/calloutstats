/**
 * Prebuild: render one 1200x630 Open Graph PNG per KOL (plus a site default)
 * into public/og/, using next/og's ImageResponse (satori + resvg, bundled with
 * Next, so no extra dependencies).
 *
 * Why not app/kol/[handle]/opengraph-image.tsx? It does render under
 * `output: "export"`, but the exported file has no extension
 * (out/kol/<handle>/opengraph-image-<hash>), so static hosts serve it without
 * an image content-type and link unfurls are unreliable. Pre-rendered .png
 * files sidestep that.
 *
 * Runs automatically as `prebuild`; also `npm run og`.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ogFileName } from "../lib/ogName.mjs";

const require = createRequire(import.meta.url);
const { ImageResponse } = require("next/og");
const React = require("react");
const h = React.createElement;

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(SITE, "public", "data");
const OUT = path.join(SITE, "public", "og");

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };

// --- minimal formatters; keep output identical to lib/format.ts ---
const trimZeros = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
function fmtCompact(abs) {
  if (abs >= 1e9) return trimZeros((abs / 1e9).toFixed(abs >= 1e10 ? 1 : 2)) + "B";
  if (abs >= 1e6) return trimZeros((abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)) + "M";
  if (abs >= 1e3) return trimZeros((abs / 1e3).toFixed(abs >= 1e4 ? 1 : 2)) + "K";
  if (abs >= 100) return Math.round(abs).toString();
  if (abs >= 10) return trimZeros(abs.toFixed(1));
  return trimZeros(abs.toFixed(2));
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const fmtMoney = (v) => (!isNum(v) ? "—" : (v < 0 ? "-" : v > 0 ? "+" : "") + "$" + fmtCompact(Math.abs(v)));
const fmtInt = (v) => (!isNum(v) ? "—" : Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => (n < 10 ? "0" + n : String(n));
function fmtDateTimeUTC(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
const color = (v) => (!isNum(v) ? "#5b6278" : v > 0 ? "#34d399" : v < 0 ? "#f87171" : "#8b92a8");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const WIDTH = 1200, HEIGHT = 630;
const frame = (children) =>
  h("div", { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0b0d12", color: "#e7e9f0", padding: 56, fontFamily: "sans-serif" } }, ...children);
const brand = (right) =>
  h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
    h("div", { style: { display: "flex", alignItems: "center", fontSize: 30, color: "#8b92a8" } },
      h("div", { style: { display: "flex", width: 20, height: 20, borderRadius: 10, background: "#34d399", marginRight: 14 } }),
      h("div", { style: { display: "flex" } }, "Callout Check")),
    h("div", { style: { display: "flex", fontSize: 26, color: "#5b6278" } }, right));
const stat = (label, value, c) =>
  h("div", { style: { display: "flex", flexDirection: "column", flex: 1, background: "#141821", border: "2px solid #252b3a", borderRadius: 18, padding: "22px 28px" } },
    h("div", { style: { display: "flex", fontSize: 24, color: "#8b92a8", letterSpacing: 2, textTransform: "uppercase" } }, label),
    h("div", { style: { display: "flex", fontSize: 60, fontWeight: 700, color: c, marginTop: 6 } }, value));
const footer = (left, right) =>
  h("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "auto", fontSize: 24, color: "#5b6278" } },
    h("div", { style: { display: "flex" } }, left),
    h("div", { style: { display: "flex" } }, right));

function kolImage(kol, win, updated) {
  const agg = kol.windows?.[win.id] ?? null;
  const name = kol.displayName || kol.handle;
  return frame([
    brand(win.label),
    h("div", { style: { display: "flex", flexDirection: "column", marginTop: 30 } },
      h("div", { style: { display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.1 } }, clip(name, 28)),
      h("div", { style: { display: "flex", fontSize: 30, color: "#8b92a8", marginTop: 6 } }, `@${clip(kol.handle, 40)} · pump.fun callouts`)),
    agg
      ? h("div", { style: { display: "flex", gap: 20, marginTop: 36 } },
          stat("1h PNL", fmtMoney(agg.pnl1h), color(agg.pnl1h)),
          stat("1d PNL", fmtMoney(agg.pnl1d), color(agg.pnl1d)),
          stat("Peak PNL", fmtMoney(agg.peak), color(agg.peak)))
      : h("div", { style: { display: "flex", marginTop: 36, fontSize: 36, color: "#8b92a8" } }, "No callout data for this window yet."),
    footer(agg ? `${fmtInt(agg.callouts)} callouts · ${fmtInt(agg.tailers)} tailers · as displayed by pump.fun` : "as displayed by pump.fun", updated ? `updated ${fmtDateTimeUTC(updated)}` : ""),
  ]);
}

function defaultImage(meta, updated) {
  return frame([
    brand("pump.fun KOL callouts"),
    h("div", { style: { display: "flex", flexDirection: "column", marginTop: 60 } },
      h("div", { style: { display: "flex", fontSize: 72, fontWeight: 700, lineHeight: 1.1 } }, "Callout Check"),
      h("div", { style: { display: "flex", fontSize: 34, color: "#8b92a8", marginTop: 18, lineHeight: 1.3 } }, "What pump.fun itself reports for each KOL's callouts: tailers and 1h / 1d / peak tailer PNL.")),
    footer(`${fmtInt(meta.kolCount)} KOLs · ${fmtInt(meta.calloutCount)} callouts tracked`, updated ? `updated ${fmtDateTimeUTC(updated)}` : ""),
  ]);
}

async function render(element, file) {
  const res = new ImageResponse(element, { width: WIDTH, height: HEIGHT });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const meta = readJson(path.join(DATA, "meta.json"), {}) ?? {};
const kols = readJson(path.join(DATA, "kols.json"), []);
const windows = Array.isArray(meta.windows) && meta.windows.length ? meta.windows : [{ id: "all", label: "All time" }];
const win = windows.find((w) => w.id === meta.defaultWindow) ?? windows[0];
const updated = meta.run?.finishedAt ?? meta.generatedAt ?? null;

fs.mkdirSync(OUT, { recursive: true });
const keep = new Set(["default.png"]);
await render(defaultImage({ kolCount: meta.kolCount ?? 0, calloutCount: meta.calloutCount ?? 0 }, updated), path.join(OUT, "default.png"));
let n = 0;
for (const kol of Array.isArray(kols) ? kols : []) {
  if (!kol || typeof kol.handle !== "string") continue;
  const name = ogFileName(kol.handle);
  keep.add(name);
  await render(kolImage(kol, win, updated), path.join(OUT, name));
  n++;
}
// prune images for handles no longer in the dataset
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png") && !keep.has(f)) fs.unlinkSync(path.join(OUT, f));
console.log(`og: wrote ${n} KOL image${n === 1 ? "" : "s"} + default.png to public/og (window: ${win.label})`);
