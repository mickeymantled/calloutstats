import { fmtMoney, fmtRewards, signClass } from "@/lib/format";

interface Props {
  value: number | null | undefined;
  /** pump.fun profile the figure came from; every number links back to its source */
  href: string;
  /** show "+" on positives (PNL figures) */
  sign?: boolean;
  /** rewards unit from the leaderboard (USD, SOL, ...); switches to rewards formatting */
  unit?: string | null;
  title?: string;
  className?: string;
}

/** A $ figure, colored by sign, linking to the pump.fun profile it was read from. */
export function Money({ value, href, sign = true, unit, title, className = "" }: Props) {
  const text = unit !== undefined ? fmtRewards(value, unit) : fmtMoney(value, { sign });
  return (
    <a className={`num ${signClass(value)} ${className}`.trim()} href={href} target="_blank" rel="noopener noreferrer" title={title ?? "Source: pump.fun profile"}>
      {text}
    </a>
  );
}

/** Any other figure (counts, multipliers, ratios) with the same source link. */
export function Num({ text, href, className = "", title }: { text: string; href: string; className?: string; title?: string }) {
  return (
    <a className={`num ${text === "—" ? "na" : ""} ${className}`.trim()} href={href} target="_blank" rel="noopener noreferrer" title={title ?? "Source: pump.fun profile"}>
      {text}
    </a>
  );
}
