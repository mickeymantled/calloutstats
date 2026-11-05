import fs from "node:fs";
import type { BrowserContext, Response } from "playwright";
import { ENDPOINTS_PATH } from "../config";
import { log } from "../log";

/**
 * Passive XHR/fetch logger. While the page is scraped, records every JSON
 * response from *.pump.fun whose body mentions "tailers" or "callout", with
 * the response shape (keys only, never values). Output: data/discovered_endpoints.json.
 */
export interface EndpointRecord {
  url: string;
  host: string;
  path: string;
  method: string;
  status: number;
  resourceType: string;
  hits: number;
  firstSeen: string;
  lastSeen: string;
  /** keys only, no values */
  shape: unknown;
  /** which keywords matched the body */
  matched: string[];
  /** true when the body is (or contains) an array of objects with tailer/callout keys */
  looksLikeCallouts: boolean;
  exampleUrl: string;
  sampleHandle: string | null;
}

/** Replace query values and the current handle with placeholders so URLs group. */
function templateUrl(u: URL, handle: string | null): string {
  let p = u.pathname;
  if (handle) p = p.split(encodeURIComponent(handle)).join(":handle").split(handle).join(":handle");
  // long opaque segments (wallets, ids) -> :id
  p = p.replace(/\/[A-Za-z0-9_-]{25,}(?=\/|$)/g, "/:id");
  const q = [...u.searchParams.keys()].sort().map((k) => `${k}=<v>`).join("&");
  return `${u.protocol}//${u.host}${p}${q ? "?" + q : ""}`;
}

export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 5) return "...";
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1), `(${v.length} items)`] : [];
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).slice(0, 60)) out[k] = shapeOf((v as any)[k], depth + 1);
    return out;
  }
  return typeof v;
}

function hasTailerArray(v: unknown, depth = 0): boolean {
  if (depth > 4 || !v) return false;
  if (Array.isArray(v)) {
    const first = v.find((x) => x && typeof x === "object");
    return !!first && Object.keys(first).some((k) => /tailer|callout/i.test(k));
  }
  if (typeof v === "object") return Object.values(v as object).some((x) => hasTailerArray(x, depth + 1));
  return false;
}

export class EndpointDiscovery {
  records = new Map<string, EndpointRecord>();
  currentHandle: string | null = null;
  private pending: Promise<void>[] = [];

  attach(ctx: BrowserContext) {
    ctx.on("response", (res) => {
      const p = this.onResponse(res).catch(() => {});
      this.pending.push(p);
      if (this.pending.length > 200) this.pending = this.pending.slice(-50);
    });
  }

  async onResponse(res: Response) {
    const url = res.url();
    let u: URL;
    try { u = new URL(url); } catch { return; }
    if (!/pump/i.test(u.hostname)) return;
    const rt = res.request().resourceType();
    if (rt !== "xhr" && rt !== "fetch") return;
    const ct = res.headers()["content-type"] ?? "";
    if (!/json/i.test(ct)) return;
    let text: string;
    try { text = await res.text(); } catch { return; }
    if (!text || text.length > 8_000_000) return;
    const matched: string[] = [];
    if (/tailer/i.test(text)) matched.push("tailers");
    if (/callout/i.test(text)) matched.push("callout");
    if (!matched.length) return;
    let json: unknown;
    try { json = JSON.parse(text); } catch { return; }

    const tpl = templateUrl(u, this.currentHandle);
    const key = `${res.request().method()} ${tpl}`;
    const now = new Date().toISOString();
    const existing = this.records.get(key);
    if (existing) {
      existing.hits++;
      existing.lastSeen = now;
      return;
    }
    const rec: EndpointRecord = {
      url: tpl,
      host: u.host,
      path: u.pathname,
      method: res.request().method(),
      status: res.status(),
      resourceType: rt,
      hits: 1,
      firstSeen: now,
      lastSeen: now,
      shape: shapeOf(json),
      matched,
      looksLikeCallouts: hasTailerArray(json),
      exampleUrl: url,
      sampleHandle: this.currentHandle,
    };
    this.records.set(key, rec);
    log.info(`discovered JSON endpoint: ${rec.method} ${rec.url} (${matched.join(",")}${rec.looksLikeCallouts ? ", looks like a callouts list" : ""})`);
  }

  async flush() { await Promise.allSettled(this.pending); }

  /** Merge with the existing file and write. Returns all known endpoints. */
  async save(file = ENDPOINTS_PATH) {
    await this.flush();
    let prev: EndpointRecord[] = [];
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")).endpoints ?? []; } catch { /* first time */ }
    const merged = new Map<string, EndpointRecord>();
    for (const r of prev) merged.set(`${r.method} ${r.url}`, r);
    for (const [k, r] of this.records) {
      const old = merged.get(k);
      merged.set(k, old ? { ...old, ...r, hits: old.hits + r.hits, firstSeen: old.firstSeen } : r);
    }
    const endpoints = [...merged.values()].sort((a, b) => b.hits - a.hits);
    fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), note: "Response shapes are keys only, no values.", endpoints }, null, 2));
    return endpoints;
  }
}
