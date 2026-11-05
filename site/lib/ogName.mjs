/**
 * File name of a KOL's OG image under public/og/. Shared by scripts/build-og.mjs
 * (which writes the PNGs) and lib/site.ts (which links to them). Plain JS so the
 * prebuild script can run without a TypeScript toolchain.
 *
 * Handles can contain spaces, dots, unicode... so the name is sanitized and
 * suffixed with a short hash of the raw handle to stay unique and URL-safe.
 */
export function ogFileName(handle) {
  let h = 0x811c9dc5;
  for (let i = 0; i < handle.length; i++) {
    h ^= handle.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const safe = handle.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "kol";
  return `${safe}-${h.toString(36)}.png`;
}
