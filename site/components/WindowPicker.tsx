"use client";
import type { Meta } from "@/lib/types";
import { CUSTOM_ID, selFromDate, sinceForInput, type WindowSel } from "@/lib/windows";

interface Props {
  meta: Meta;
  sel: WindowSel;
  onChange: (sel: WindowSel) => void;
  compact?: boolean;
}

/** Preset windows from meta.json plus a free "since" date (computed client side). */
export function WindowPicker({ meta, sel, onChange, compact }: Props) {
  const customActive = sel.id === CUSTOM_ID;
  return (
    <div className="toolbar" style={{ margin: 0 }}>
      <div className="seg" role="tablist" aria-label="Window">
        {meta.windows.map((w) => (
          <button key={w.id} type="button" role="tab" aria-selected={sel.id === w.id} className={sel.id === w.id ? "active" : ""} onClick={() => onChange({ id: w.id })}>
            {compact && w.since ? "Since " + w.since : w.label}
          </button>
        ))}
        {customActive && (
          <button type="button" role="tab" aria-selected className="active" title="Custom start date, computed in your browser from callouts.json">
            Since {sel.since}
          </button>
        )}
      </div>
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <span>Since</span>
        <input
          type="date"
          aria-label="Custom since date"
          value={sinceForInput(sel, meta)}
          onChange={(e) => e.target.value && onChange(selFromDate(e.target.value, meta))}
        />
      </label>
    </div>
  );
}
