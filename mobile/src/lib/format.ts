/** Formatting and the status vocabularies — tints match the web app's badges. */

export type Tone = "pri" | "vio" | "suc" | "warn" | "dest" | "neutral";

export const TONE: Record<Tone, { fg: string; bg: string; border: string; solid: string }> = {
  pri: { fg: "var(--pri-l)", bg: "hsl(215 100% 55% / .13)", border: "hsl(215 100% 55% / .38)", solid: "var(--pri)" },
  vio: { fg: "var(--vio-l)", bg: "hsl(252 80% 62% / .12)", border: "hsl(252 80% 62% / .38)", solid: "var(--vio)" },
  suc: { fg: "var(--suc-l)", bg: "hsl(152 60% 48% / .12)", border: "hsl(152 60% 48% / .4)", solid: "var(--suc)" },
  warn: { fg: "var(--warn-l)", bg: "hsl(38 92% 55% / .13)", border: "hsl(38 92% 55% / .35)", solid: "var(--warn)" },
  dest: { fg: "var(--dest-l)", bg: "hsl(0 72% 51% / .13)", border: "hsl(0 72% 51% / .3)", solid: "var(--dest)" },
  neutral: { fg: "var(--fg3)", bg: "hsl(222 16% 16%)", border: "var(--border)", solid: "hsl(220 10% 45%)" },
};

export function stageTone(stage: string | null | undefined): Tone {
  switch ((stage ?? "").toLowerCase()) {
    case "lead": return "pri";
    case "qualified": return "warn";
    case "active": return "suc";
    default: return "neutral";
  }
}

export function bookingTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toLowerCase()) {
    case "confirmed": return "suc";
    case "pending": return "warn";
    case "completed": return "pri";
    case "no_show": return "dest";
    default: return "neutral";
  }
}

export function priorityTone(priority: string | null | undefined): Tone {
  switch ((priority ?? "").toLowerCase()) {
    case "urgent": return "dest";
    case "high": return "warn";
    case "medium": return "pri";
    default: return "neutral";
  }
}

export function quoteTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toLowerCase()) {
    case "sent":
    case "viewed": return "pri";
    case "accepted":
    case "approved":
    case "paid":
    case "deposit_paid": return "suc";
    case "expired": return "dest";
    default: return "neutral";
  }
}

export function runTone(status: string | null | undefined): Tone {
  switch ((status ?? "").toLowerCase()) {
    case "completed": return "suc";
    case "failed": return "dest";
    case "pending":
    case "running":
    case "waiting": return "warn";
    default: return "neutral";
  }
}

/** "in_progress" → "In progress", "deposit_paid" → "Deposit paid". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "";
  const text = value.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const cadExact = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2 });

/** $1,020 — or $12.4K when compact. */
export function money(cents: number | null | undefined, opts: { compact?: boolean; exact?: boolean } = {}): string {
  if (cents === null || cents === undefined) return "—";
  const dollars = cents / 100;
  if (opts.compact && Math.abs(dollars) >= 1000) {
    return `$${(dollars / 1000).toFixed(1)}K`;
  }
  return (opts.exact ? cadExact : cad).format(dollars).replace("CA$", "$");
}

export function timeHM(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function longDate(date: Date = new Date()): string {
  return date.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
}

/** 4m · 2h · 3d · Aug 12 */
export function relShort(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

export function relAgo(iso: string | null | undefined, now = Date.now()): string {
  const short = relShort(iso, now);
  if (!short) return "";
  return short === "now" ? "just now" : /\d[mhd]$/.test(short) ? `${short} ago` : short;
}

/** "Overdue 2d", "Due today", "Due Wed". */
export function dueLabel(dueAt: string | null | undefined, isOverdue: boolean, now = new Date()): string {
  if (!dueAt) return "No due date";
  const due = new Date(dueAt);
  if (isOverdue) {
    const days = Math.max(1, Math.round((now.getTime() - due.getTime()) / 86400000));
    return `Overdue ${days}d`;
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((due.getTime() - startOfToday.getTime()) / 86400000);
  if (diffDays <= 0) return "Due today";
  if (diffDays === 1) return "Due tomorrow";
  if (diffDays < 7) return `Due ${due.toLocaleDateString("en-CA", { weekday: "short" })}`;
  return `Due ${due.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`;
}

export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const hours = seconds / 3600;
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(seconds / 60)}m`;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Monday-first week start. */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}
