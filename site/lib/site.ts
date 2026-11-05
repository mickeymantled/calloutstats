/** URL helpers usable from both server and client code. */
import { ogFileName } from "./ogName.mjs";

export const SITE_NAME = "Callout Check";
export const SITE_DESCRIPTION =
  "What pump.fun itself reports for each KOL's callouts: callouts, tailers, 1h / 1d / peak tailer PNL, summed over a window. Verify viral copy-trader PNL graphics against pump.fun's own numbers.";

/** Absolute site origin used for metadataBase / OG URLs. */
export function siteUrl(): URL {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const raw = explicit || (vercel ? `https://${vercel}` : "http://localhost:3000");
  try {
    return new URL(raw);
  } catch {
    return new URL("http://localhost:3000");
  }
}

export const enc = (handle: string) => encodeURIComponent(handle);
export const kolHref = (handle: string) => `/kol/${enc(handle)}`;
export const embedHref = (handle: string) => `/embed/${enc(handle)}`;
export const compareHref = (handle: string) => `/compare?handle=${enc(handle)}`;
/** Pre-rendered OG image (see scripts/build-og.mjs). */
export const ogImageHref = (handle: string) => `/og/${ogFileName(handle)}`;
export const OG_DEFAULT = "/og/default.png";
export const OG_SIZE = { width: 1200, height: 630 };

/** Decode a route param that may or may not already be decoded. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
