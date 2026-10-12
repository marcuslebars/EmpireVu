/**
 * Compliance documents in plain words (PURE): the kinds, how we name them to the owner, the words
 * in an owner's text that mean "this is a compliance document", dates and statuses.
 */
import type { ComplianceKind, DocStatus } from "./db-types";

export const COMPLIANCE_KINDS: readonly ComplianceKind[] = [
  "liability_insurance",
  "wsib_clearance",
  "wsib_account",
  "vehicle_insurance",
  "trade_licence",
  "business_licence",
  "certification",
  "bond",
  "other",
] as const;

export function isComplianceKind(value: unknown): value is ComplianceKind {
  return typeof value === "string" && (COMPLIANCE_KINDS as readonly string[]).includes(value);
}

const KIND_LABELS: Record<ComplianceKind, string> = {
  liability_insurance: "liability insurance",
  wsib_clearance: "WSIB clearance",
  wsib_account: "WSIB account",
  vehicle_insurance: "vehicle insurance",
  trade_licence: "trade licence",
  business_licence: "business licence",
  certification: "certification",
  bond: "bond",
  other: "document",
};

/** Kinds a business itself is expected to hold (compliance_status "missing"). */
export const COMPANY_CORE_KINDS: readonly ComplianceKind[] = ["liability_insurance", "wsib_clearance"];
/** What a sub is asked for by default ("a new clearance + insurance"). */
export const SUB_CORE_KINDS: readonly ComplianceKind[] = ["wsib_clearance", "liability_insurance"];

/** Days before expiry when a document counts as "expiring" and the owner hears about it. */
export const EXPIRING_DAYS = 30;
export const REMINDER_STAGES = [30, 7, 0] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];

export function kindLabel(kind: ComplianceKind, title?: string | null): string {
  const t = title?.trim();
  if (t && (kind === "certification" || kind === "trade_licence" || kind === "other")) return t;
  return KIND_LABELS[kind] ?? "document";
}

/** "liability insurance" → "Liability insurance". */
export function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Words that mean the owner is sending a compliance document. The tax clerk passes on the same
 * words (insurance, certificate, COI, WSIB, clearance, licence/license, permit, ticket, cert, policy).
 */
const COMPLIANCE_WORDS =
  /\b(insurance|insured|insurer|certificates?|certs?|certifications?|coi|wsib|clearances?|licen[cs]es?|permits?|tickets?|polic(y|ies)|bond(ed)?|whmis|first[ -]aid|working at heights|tssa|ecra|esa|309a|306a|313a|g2)\b/i;

export function mentionsCompliance(text: string | null | undefined): boolean {
  return Boolean(text && COMPLIANCE_WORDS.test(text));
}

/**
 * The kind the owner's words point to, only when they name a SPECIFIC document. Generic words
 * ("permit", "policy", "ticket", "cert", "certificate") are not enough on their own. PURE.
 */
export function kindFromWords(text: string | null | undefined): ComplianceKind | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\bwsib\b/.test(t)) return /\baccount\b/.test(t) && !/\bclearance/.test(t) ? "wsib_account" : "wsib_clearance";
  if (/\bclearance (cert|certificate|letter)\b|\bclearance\b/.test(t)) return "wsib_clearance";
  if (/\b(vehicle|auto|truck|car|fleet)\b.*\binsurance\b|\binsurance\b.*\b(vehicle|auto|truck|car|fleet)\b/.test(t)) return "vehicle_insurance";
  if (/\b(insurance|coi|liability|insured|insurer)\b/.test(t)) return "liability_insurance";
  if (/\b(surety|performance|bid|licen[cs]e) bond\b|\bbonded\b/.test(t)) return "bond";
  if (/\bbusiness licen[cs]e/.test(t)) return "business_licence";
  if (/\b(309a|306a|313a|tssa|g2|ecra|esa)\b|\b(trade|gas|electrical|electrician'?s?|plumbing|plumber'?s?|contractor'?s?) licen[cs]e/.test(t)) return "trade_licence";
  if (/\b(whmis|first[ -]aid|working at heights|cpr|fall arrest|forklift)\b/.test(t)) return "certification";
  return null;
}

/** Words that mean money changed hands (a receipt, a bill, a fee) — never a certificate on words alone. */
const PAYMENT_WORDS = /\b(paid|pay|payment|payments|fee|fees|invoice|invoiced|receipt|receipts|bill|billed|bills|renewal cost|premium paid)\b/i;

export function mentionsPayment(text: string | null | undefined): boolean {
  return Boolean(text && PAYMENT_WORDS.test(text));
}

/** Words alone (no reading) are enough to claim: a specific kind and nothing about paying. PURE. */
export function wordsClaim(text: string | null | undefined): ComplianceKind | null {
  if (mentionsPayment(text)) return null;
  return kindFromWords(text);
}

// ── Dates ────────────────────────────────────────────────────────────────────────────

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Whole days from `from` to `to` (YYYY-MM-DD). PURE. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mar 31, 2027" (the year only when it isn't `todayYear`'s). */
export function prettyDate(date: string, today?: string): string {
  const [y, m, d] = date.split("-").map((n) => Number.parseInt(n, 10));
  const base = `${MONTHS[m - 1]} ${d}`;
  return today && today.slice(0, 4) === String(y) ? base : `${base}, ${y}`;
}

/** "Fri" within the week ahead, else "Fri Oct 16" (and the year when it isn't this one). */
export function whenText(date: string, today: string): string {
  const days = daysBetween(today, date);
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return weekday;
  return `${weekday} ${prettyDate(date, today)}`;
}

/** current / expiring (≤ 30 days) / expired, from the expiry date. No date → current. PURE. */
export function statusFor(expiresOn: string | null, today: string): Exclude<DocStatus, "pending" | "replaced"> {
  if (!expiresOn) return "current";
  const days = daysBetween(today, expiresOn);
  if (days < 0) return "expired";
  return days <= EXPIRING_DAYS ? "expiring" : "current";
}

/** The reminder stage due now for a document expiring on `expiresOn`, or null. PURE. */
export function dueStage(expiresOn: string, today: string): ReminderStage | null {
  const days = daysBetween(today, expiresOn);
  // On the day (or, if a worker was down, up to 2 days after).
  if (days <= 0 && days >= -2) return 0;
  if (days >= 1 && days <= 7) return 7;
  if (days >= 8 && days <= 30) return 30;
  return null;
}

/** Stages already covered when a document is saved `days` before it expires (the save reply said so). */
export function stagesCoveredAtSave(expiresOn: string | null, today: string): ReminderStage[] {
  if (!expiresOn) return [];
  const days = daysBetween(today, expiresOn);
  const out: ReminderStage[] = [];
  if (days <= 30) out.push(30);
  if (days <= 7) out.push(7);
  if (days <= 0) out.push(0);
  return out;
}

// ── Numbers, names ───────────────────────────────────────────────────────────────────

/** "policy ...4821" / "#...4821" — never the whole number in a text. PURE. */
export function maskedNumber(kind: ComplianceKind, number: string | null | undefined): string | null {
  const clean = (number ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (clean.length < 3) return null;
  const tail = clean.length > 4 ? `...${clean.slice(-4)}` : clean;
  return kind === "liability_insurance" || kind === "vehicle_insurance" || kind === "bond" ? `policy ${tail}` : `#${tail}`;
}

const NAME_STOP = new Set(["inc", "ltd", "limited", "corp", "corporation", "co", "company", "the", "and", "llc", "llp", "of", "services", "service"]);

/** Comparable name tokens: lowercased words, apostrophes dropped, legal suffixes gone. PURE. */
export function nameTokens(name: string | null | undefined): string[] {
  return (name ?? "")
    .toLowerCase()
    .replace(/['’`]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !NAME_STOP.has(w));
}

/** Two names refer to the same holder: every token of the shorter is in the longer. PURE. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

/** Text that came from a document or a visitor: one plain line, no markup, clipped. PURE. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/[<>{}[\]`]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max).trim() : t;
}
