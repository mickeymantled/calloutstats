"use client";
import { useEffect, useState } from "react";
import type { CalloutsBundle, Kol } from "./types";

let cache: CalloutsBundle | null = null;
let inflight: Promise<CalloutsBundle> | null = null;

/** Fetch /data/callouts.json once per page; shared across components. */
export function fetchCallouts(): Promise<CalloutsBundle> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/data/callouts.json", { cache: "no-cache" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`callouts.json: HTTP ${r.status}`);
        const j = (await r.json()) as CalloutsBundle;
        cache = { generatedAt: j.generatedAt ?? "", columns: j.columns ?? [], byHandle: j.byHandle ?? {} };
        return cache;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function useCalloutsBundle(enabled: boolean) {
  const [bundle, setBundle] = useState<CalloutsBundle | null>(cache);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || bundle) return;
    let alive = true;
    fetchCallouts().then((b) => alive && setBundle(b), (e) => alive && setError(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [enabled, bundle]);
  return { bundle, error, loading: enabled && !bundle && !error };
}

let kolsCache: Kol[] | null = null;
/** Fetch /data/kols.json at runtime (used by the compare tool). */
export async function fetchKols(): Promise<Kol[]> {
  if (kolsCache) return kolsCache;
  const r = await fetch("/data/kols.json", { cache: "no-cache" });
  if (!r.ok) {
    if (r.status === 404) { kolsCache = []; return kolsCache; }
    throw new Error(`kols.json: HTTP ${r.status}`);
  }
  const j = await r.json();
  kolsCache = Array.isArray(j) ? (j as Kol[]) : [];
  return kolsCache;
}
