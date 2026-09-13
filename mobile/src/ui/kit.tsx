import { ArrowClockwise, CaretRight, Check, CloudSlash, Tray, WarningCircle, type Icon } from "@phosphor-icons/react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

import { errorMessage } from "@m/lib/api";
import { TONE, initials, type Tone } from "@m/lib/format";
import { tap } from "@m/lib/native";

// ── Buttons ───────────────────────────────────────────────

type BtnVariant = "primary" | "secondary" | "ghost" | "dashed" | "tinted";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  block?: boolean;
  flex?: boolean;
  glow?: boolean;
  loading?: boolean;
  icon?: Icon;
  iconWeight?: "regular" | "fill";
}

export function Btn({
  variant = "primary",
  tone = "pri",
  size,
  block,
  flex,
  glow,
  loading,
  icon: IconCmp,
  iconWeight = "regular",
  className,
  style,
  children,
  onClick,
  disabled,
  ...rest
}: BtnProps) {
  const tinted: CSSProperties =
    variant === "tinted" ? { background: TONE[tone].bg, border: `1px solid ${TONE[tone].border}`, color: TONE[tone].fg } : {};
  const classes = [
    "btn",
    variant === "tinted" ? "" : variant,
    size ?? "",
    block ? "block" : "",
    flex ? "flex1" : "",
    glow ? "glow" : "",
    className ?? "",
  ].join(" ");

  return (
    <button
      type="button"
      className={classes}
      style={{ ...tinted, ...style }}
      disabled={disabled || loading}
      onClick={(event) => {
        tap();
        onClick?.(event);
      }}
      {...rest}
    >
      {loading ? <span className="spinner" /> : IconCmp ? <IconCmp size={size === "sm" ? 14 : 16} weight={iconWeight} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: IconCmp, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Icon; label: string }) {
  return (
    <button type="button" aria-label={label} className={`icon-btn ${className ?? ""}`} {...rest}>
      <IconCmp size={20} />
    </button>
  );
}

// ── Labels ────────────────────────────────────────────────

export function Tag({ tone = "neutral", children, style }: { tone?: Tone; children: ReactNode; style?: CSSProperties }) {
  return (
    <span className="tag" style={{ background: TONE[tone].bg, color: TONE[tone].fg, ...style }}>
      {children}
    </span>
  );
}

export function IconBox({ icon: IconCmp, tone = "neutral", size = 30, fill, tinted }: { icon: Icon; tone?: Tone; size?: number; fill?: boolean; tinted?: boolean }) {
  return (
    <span
      className="icon-box"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 3),
        color: TONE[tone].fg,
        background: tinted ? TONE[tone].bg : undefined,
      }}
    >
      <IconCmp size={Math.round(size / 2)} weight={fill ? "fill" : "regular"} />
    </span>
  );
}

export function Avatar({ name, tone = "pri", size = 36 }: { name: string | null | undefined; tone?: Tone; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: Math.round(size / 3.2), background: TONE[tone].bg, color: TONE[tone].fg }}>
      {initials(name)}
    </span>
  );
}

export function Section({ title, action, children, style }: { title: ReactNode; action?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="section" style={style}>
      <div className="section-head">
        <span className="eyebrow">{title}</span>
        {action ? (
          <>
            <span className="rule" />
            {action}
          </>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// ── Choice controls ───────────────────────────────────────

export function Segmented<T extends string>({ options, value, onChange }: { options: readonly T[] | Array<{ value: T; label: string }>; value: T; onChange: (value: T) => void }) {
  const items = (options as Array<T | { value: T; label: string }>).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div className="seg" role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={item.value === value ? "on" : ""}
          onClick={() => {
            tap();
            onChange(item.value);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Pills<T extends string>({
  options,
  value,
  onChange,
  wrap,
  size,
}: {
  options: readonly T[] | Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  wrap?: boolean;
  size?: "tall" | "fill";
}) {
  const items = (options as Array<T | { value: T; label: string }>).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div className={wrap ? "" : "hscroll"} style={wrap ? { display: "flex", flexWrap: "wrap", gap: 6 } : size === "fill" ? { gap: 6 } : undefined}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          className={`pill ${size ?? ""} ${item.value === value ? "on" : ""}`}
          onClick={() => {
            tap();
            onChange(item.value);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch ${on ? "on" : ""}`}
      onClick={() => {
        tap();
        onChange(!on);
      }}
    />
  );
}

export function CheckBox({ on, onChange, label, tone = "suc" }: { on: boolean; onChange: () => void; label: string; tone?: "suc" | "pri" }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      className={`checkbox ${tone === "pri" ? "pri" : ""} ${on ? "on" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        tap();
        onChange();
      }}
    >
      {on ? <Check size={12} weight="bold" /> : null}
    </button>
  );
}

// ── Form fields ───────────────────────────────────────────

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="fine">{hint}</span> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="input" rows={3} {...props} />;
}

// ── Rows ──────────────────────────────────────────────────

export function NavRow({
  icon,
  tone = "neutral",
  label,
  sub,
  onClick,
  trailing,
}: {
  icon?: Icon;
  tone?: Tone;
  label: ReactNode;
  sub?: ReactNode;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      {icon ? <IconBox icon={icon} tone={tone} /> : null}
      <span className="grow">
        <span className="row-title">{label}</span>
        {sub ? <span className="row-sub">{sub}</span> : null}
      </span>
      {trailing}
      {onClick ? <CaretRight size={14} color="hsl(220 10% 35%)" /> : null}
    </>
  );
  return onClick ? (
    <button type="button" className="row" onClick={() => { tap(); onClick(); }}>
      {content}
    </button>
  ) : (
    <div className="row">{content}</div>
  );
}

export function KeyValueRows({ rows }: { rows: Array<{ k: string; v: ReactNode }> }) {
  return (
    <div className="list">
      {rows.map((row) => (
        <div key={row.k} className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ font: "500 12px/1 Inter, sans-serif", color: "var(--mut)" }}>{row.k}</span>
          <span style={{ font: "600 12.5px/1.3 Inter, sans-serif", color: "hsl(220 10% 88%)", textAlign: "right" }}>{row.v}</span>
        </div>
      ))}
    </div>
  );
}

// ── States (StateViews.tsx, plus offline) ─────────────────

export function Empty({ icon: IconCmp = Tray, title, body, action, iconTone }: { icon?: Icon; title: string; body?: string; action?: ReactNode; iconTone?: Tone }) {
  return (
    <div className="empty">
      <span className="icon" style={iconTone ? { color: TONE[iconTone].fg } : undefined}>
        <IconCmp size={20} />
      </span>
      <span className="t">{title}</span>
      {body ? <span className="b">{body}</span> : null}
      {action}
    </div>
  );
}

export function ErrorBanner({ error, onRetry, message }: { error?: unknown; onRetry?: () => void; message?: string }) {
  return (
    <div className="banner error" role="alert">
      <WarningCircle weight="fill" size={16} color="hsl(0 72% 62%)" />
      <span style={{ flex: 1, font: "400 12.5px/1.4 Inter, sans-serif", color: "hsl(220 10% 84%)" }}>{message ?? errorMessage(error)}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} style={{ background: "none", border: 0, font: "600 11.5px/1 Inter, sans-serif", color: "var(--dest-l)", display: "flex", alignItems: "center", gap: 5, padding: 6 }}>
          <ArrowClockwise size={13} />
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function OfflineBanner({ queued }: { queued: number }) {
  return (
    <div className="banner warn" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <CloudSlash weight="fill" size={17} color="var(--warn-l)" />
        <span style={{ font: "600 12.5px/1 Inter, sans-serif", color: "hsl(38 92% 72%)" }}>Offline — showing cached data</span>
      </span>
      <span style={{ font: "400 12px/1.5 Inter, sans-serif", color: "hsl(220 10% 58%)" }}>
        Photos queue and upload when signal returns{queued ? ` · ${queued} queued` : ""}.
      </span>
    </div>
  );
}

export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" aria-hidden>
          <span style={{ width: "66%" }} />
          <span style={{ width: "100%" }} />
          <span style={{ width: "48%" }} />
        </div>
      ))}
    </>
  );
}

/** Loading / error / empty / data for one query — every list uses all four. */
export function QueryView<T>({
  query,
  isEmpty,
  empty,
  skeletons = 3,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeletons?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Skeletons count={skeletons} />;
  if (query.isError) return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />;
  if (isEmpty?.(query.data) && empty) return <>{empty}</>;
  return <>{children(query.data)}</>;
}

// ── Pull to refresh ───────────────────────────────────────

export function PullToRefresh({ onRefresh, children }: { onRefresh?: () => Promise<unknown>; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const THRESHOLD = 64;

  return (
    <div
      ref={scroller}
      className="scroll"
      onTouchStart={(e) => {
        if (!onRefresh || refreshing) return;
        startY.current = (scroller.current?.scrollTop ?? 0) <= 0 ? e.touches[0]!.clientY : null;
      }}
      onTouchMove={(e) => {
        if (startY.current === null) return;
        const delta = e.touches[0]!.clientY - startY.current;
        setPull(delta > 0 ? Math.min(96, delta * 0.5) : 0);
      }}
      onTouchEnd={() => {
        if (startY.current === null) return;
        startY.current = null;
        if (pull >= THRESHOLD * 0.75 && onRefresh) {
          setRefreshing(true);
          setPull(44);
          tap();
          void onRefresh().finally(() => {
            setRefreshing(false);
            setPull(0);
          });
        } else {
          setPull(0);
        }
      }}
    >
      <div className="ptr" style={{ height: pull }} aria-hidden={!refreshing}>
        {pull > 8 ? <span className="spinner" style={{ animationPlayState: refreshing ? "running" : "paused" }} /> : null}
      </div>
      {children}
    </div>
  );
}
