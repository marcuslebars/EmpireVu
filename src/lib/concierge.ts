/**
 * Concierge console — shapes shared by the API (src/server/services/concierge) and the
 * operator SPA (src/screens/concierge). Pure; no I/O.
 */

export type ConciergeStage = "needs_call" | "setting_up" | "live";
export type SlaLevel = "green" | "amber" | "red";
export type NumberStatus = "active" | "pending" | "failed";

export const SLA_AMBER_HOURS = 12;
export const SLA_RED_HOURS = 24;
/** A buyer not live this long after purchase needs a call. */
export const NEEDS_CALL_AFTER_HOURS = 24;
/** The text-back / AI number is bought at purchase; missing after this long counts as failed. */
export const NUMBER_EXPECTED_WITHIN_HOURS = 1;

/** green < 12h, amber 12–24h, red > 24h since purchase. */
export function slaLevel(hoursSincePurchase: number): SlaLevel {
  if (hoursSincePurchase < SLA_AMBER_HOURS) return "green";
  if (hoursSincePurchase <= SLA_RED_HOURS) return "amber";
  return "red";
}

/** "3h", "1d 4h", "12d". */
export function formatAge(hours: number): string {
  const h = Math.max(0, Math.floor(hours));
  if (h < 1) return "<1h";
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return d >= 7 || rest === 0 ? `${d}d` : `${d}d ${rest}h`;
}

const CARRIER_LABELS: Record<string, string> = {
  bell: "Bell",
  rogers: "Rogers",
  telus: "Telus",
  fido: "Fido",
  koodo: "Koodo",
  virgin: "Virgin Plus",
  freedom: "Freedom",
  videotron: "Vidéotron",
  other: "Other carrier",
};

export const PHONE_CARRIERS = Object.keys(CARRIER_LABELS);
export const PHONE_KINDS = ["cell", "landline", "voip"] as const;
export type PhoneKind = (typeof PHONE_KINDS)[number];

export function carrierLabel(carrier: string | null | undefined): string | null {
  if (!carrier?.trim()) return null;
  const key = carrier.trim().toLowerCase();
  return CARRIER_LABELS[key] ?? carrier.trim();
}

export function phoneKindLabel(kind: string | null | undefined): string | null {
  if (kind === "cell") return "cell";
  if (kind === "landline") return "landline";
  if (kind === "voip") return "VoIP line";
  return null;
}

export interface ConciergeStepDot {
  key: string;
  title: string;
  done: boolean;
}

export interface ConciergeAccountSummary {
  organizationId: string;
  companyId: string | null;
  businessName: string;
  tier: string | null;
  purchasedAt: string;
  hoursSincePurchase: number;
  sla: SlaLevel;
  owner: { name: string | null; email: string | null; phone: string | null };
  intake: { status: string | null; submittedAt: string | null; enrichedAt: string | null; lastError: string | null };
  /** Which facts enrichment found (top-level keys with a value), or null before enrichment. */
  enrichment: { fields: string[]; error: string | null } | null;
  phone: {
    /** "missed_call_catcher" (text-back) or "ai_receptionist" (Front Desk / Marina). */
    path: string;
    textBackNumber: string | null;
    aiNumber: string | null;
    status: NumberStatus;
    forwardingVerifiedAt: string | null;
  };
  site: { slug: string; status: string; mode: string; publishedAt: string | null } | null;
  checklist: { doneCount: number; totalCount: number; steps: ConciergeStepDot[]; nextStepTitle: string | null } | null;
  isLive: boolean;
  needsCall: boolean;
  needsCallReasons: string[];
  stage: ConciergeStage;
}

export interface CallScriptItem {
  key: string;
  /** Plain words, e.g. "Forwarding not on yet — Bell cell: have them dial". */
  text: string;
  /** Something to read out exactly (a dial code), shown bold + monospace. */
  code?: string;
}

export interface CallScript {
  ownerName: string | null;
  ownerFirstName: string | null;
  ownerPhone: string | null;
  missing: CallScriptItem[];
}

export interface ConciergeService {
  id: string;
  label: string;
  unitLabel: string | null;
  pricingType: string;
  rateCents: number;
  minimumCents: number;
  active: boolean;
  needsPrice: boolean;
}

export interface ConciergeActivity {
  id: string;
  operatorEmail: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ConciergeFollowup {
  id: string;
  stage: string;
  localDate: string;
  smsStatus: string | null;
  emailStatus: string | null;
  createdAt: string;
}

export interface ConciergeCompanyFacts {
  id: string;
  name: string;
  website: string | null;
  hours: unknown;
  hoursText: string | null;
  serviceArea: string | null;
  logoUrl: string | null;
  reviewUrl: string | null;
  googlePlaceId: string | null;
  googleRating: number | null;
  googleReviewCount: number | null;
  businessPhone: string | null;
  ownerPhone: string | null;
  phoneKind: string | null;
  phoneCarrier: string | null;
  timezone: string | null;
  profile: Record<string, unknown>;
}

export interface ConciergeActionInfo {
  name: string;
  label: string;
}

export interface ConciergeAccountDetail {
  account: ConciergeAccountSummary;
  company: ConciergeCompanyFacts | null;
  services: ConciergeService[];
  automations: Array<{ id: string; name: string; slug: string; status: string }>;
  activity: ConciergeActivity[];
  followups: ConciergeFollowup[];
  callScript: CallScript;
  actions: ConciergeActionInfo[];
}

export interface ConciergeActionResponse {
  action: string;
  message: string;
  result?: unknown;
}

/** Hours JSON (wizard: `{ summary }`; per-day `{ mon: { open, close } }`) → one line. */
export function hoursToText(hours: unknown): string | null {
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) return null;
  const record = hours as Record<string, unknown>;
  if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  const entries = Object.entries(record);
  if (entries.length === 0) return null;
  return entries
    .map(([day, v]) => {
      if (v && typeof v === "object" && "open" in v && "close" in v) {
        const o = (v as { open?: unknown }).open;
        const c = (v as { close?: unknown }).close;
        return `${day} ${String(o ?? "?")}–${String(c ?? "?")}`;
      }
      return `${day} ${String(v)}`;
    })
    .join(", ");
}

/** Cents → "$125" / "$125.50". */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-CA", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}
