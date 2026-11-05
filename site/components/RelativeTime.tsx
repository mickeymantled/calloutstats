"use client";
import { useEffect, useState } from "react";
import { fmtAgo, fmtDateTimeUTC } from "@/lib/format";

/** Renders a UTC timestamp on the server, then adds a live "x ago" after hydration. */
export function RelativeTime({ iso }: { iso: string | null | undefined }) {
  const [ago, setAgo] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const tick = () => setAgo(fmtAgo(iso));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return <span>—</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toString()} suppressHydrationWarning>
      {fmtDateTimeUTC(iso)}{ago ? ` (${ago})` : ""}
    </time>
  );
}
