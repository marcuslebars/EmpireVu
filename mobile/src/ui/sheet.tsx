import { Check, type Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { TONE, type Tone } from "@m/lib/format";
import { tap } from "@m/lib/native";

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true">
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet">
        <div className="grabber" />
        <div className="sheet-title">{title}</div>
        <div className="scroll" style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "68vh", flex: "none" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SheetGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {label ? (
        <span style={{ font: "700 9.5px/1 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".14em", color: "var(--faint)", padding: "2px 2px 0" }}>
          {label}
        </span>
      ) : null}
      {children}
    </div>
  );
}

export function SheetItem({
  icon: IconCmp,
  tone = "neutral",
  tint,
  label,
  checked,
  onClick,
  fill,
}: {
  icon: Icon;
  tone?: Tone;
  tint?: string;
  label: ReactNode;
  checked?: boolean;
  onClick: () => void;
  fill?: boolean;
}) {
  return (
    <button
      type="button"
      className={`sheet-item ${checked ? "on" : ""}`}
      onClick={() => {
        tap();
        onClick();
      }}
    >
      <span className="icon-box" style={{ background: "hsl(222 16% 15%)", color: tint ?? TONE[tone].fg, fontSize: 16 }}>
        <IconCmp size={16} weight={fill ? "fill" : "regular"} />
      </span>
      <span className="label">{label}</span>
      {checked ? <Check size={16} color="hsl(215 100% 62%)" /> : null}
    </button>
  );
}
