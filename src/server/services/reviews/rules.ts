/**
 * Review requests — PURE rules: settings and their defaults, sending hours, message
 * templates, and the send-time decision. No I/O; pinned by src/test/review-requests.test.ts.
 * See docs/review-requests.md.
 */
import { z } from "zod";

import { addDays, localDateString } from "@/server/services/invoices/math";
import { tzOffsetMs } from "@/server/services/attribution";

// ── Settings (companies.review_settings jsonb) ──────────────────────────────

export const REVIEW_TRIGGERS = ["job_done", "invoice_paid"] as const;
export const REVIEW_CHANNELS = ["sms_or_email", "sms", "email"] as const;

export const DEFAULT_SMS_TEMPLATE =
  "Hi {{first_name}}, thanks for choosing {{company}}! If you have a minute, would you leave us a quick review? {{link}}";
export const DEFAULT_EMAIL_SUBJECT = "How did we do?";
export const DEFAULT_EMAIL_TEMPLATE =
  "Hi {{first_name}},\n\nThanks for choosing {{company}}. If you have a minute, a quick review helps a small business like ours more than you'd think:\n\n{{link}}\n\nThank you!\n{{company}}";

const LINK_TOKEN = /\{\{\s*link\s*\}\}/;

const template = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => LINK_TOKEN.test(v), "Include {{link}} so the customer has somewhere to click.");

export const reviewSettingsSchema = z.object({
  enabled: z.boolean(),
  trigger: z.enum(REVIEW_TRIGGERS),
  /** Hours after the job is done / invoice is paid (then moved into sending hours). */
  delayHours: z.number().int().min(0).max(168),
  channel: z.enum(REVIEW_CHANNELS),
  /** Don't ask the same customer again within this many days (0 = no limit). */
  cooldownDays: z.number().int().min(0).max(730),
  smsTemplate: template(320),
  emailSubject: z.string().trim().min(1).max(150),
  emailTemplate: template(2000),
});

export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  enabled: false,
  trigger: "job_done",
  delayHours: 2,
  channel: "sms_or_email",
  cooldownDays: 90,
  smsTemplate: DEFAULT_SMS_TEMPLATE,
  emailSubject: DEFAULT_EMAIL_SUBJECT,
  emailTemplate: DEFAULT_EMAIL_TEMPLATE,
};

/** Stored jsonb → full settings. Anything missing or invalid falls back to its default. */
export function parseReviewSettings(raw: unknown): ReviewSettings {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...DEFAULT_REVIEW_SETTINGS };
  const shape = reviewSettingsSchema.shape;
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    if (!(key in obj)) continue;
    const parsed = shape[key].safeParse(obj[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as ReviewSettings;
}

/** A review link must be a full https URL (Google, Facebook, Yelp, HomeStars…). */
export function normalizeReviewUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new ReviewRuleError("Paste the full review link, starting with https://");
  }
  if (url.protocol !== "https:") throw new ReviewRuleError("The review link must start with https://");
  return url.toString();
}

export class ReviewRuleError extends Error {}

// ── Sending hours ───────────────────────────────────────────────────────────

/** companies.timezone → BUSINESS_TIMEZONE → America/Toronto (same chain as invoices). */
export function reviewTimeZone(company: { timezone?: string | null } | null): string {
  return company?.timezone?.trim() || process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

/** Automatic asks go out between 9am and 8pm, the brand's local time. */
export const SEND_FROM_HOUR = 9;
export const SEND_UNTIL_HOUR = 20;

function localHour(ms: number, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(ms));
  return Number(h) % 24;
}

/** `ms` if it falls in sending hours, else the next 9:00 local. */
export function nextSendTime(ms: number, timeZone: string): number {
  const hour = localHour(ms, timeZone);
  if (hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR) return ms;
  const today = localDateString(new Date(ms), timeZone);
  const day = hour < SEND_FROM_HOUR ? today : addDays(today, 1);
  return localTimeUtc(day, SEND_FROM_HOUR, timeZone);
}

/** UTC ms of `hour`:00 local on `ymd` — computed at that hour, so a DST change earlier that day is respected. */
export function localTimeUtc(ymd: string, hour: number, timeZone: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  let utc = naive - tzOffsetMs(naive, timeZone);
  utc = naive - tzOffsetMs(utc, timeZone);
  return utc;
}

export function scheduleFor(eventMs: number, settings: Pick<ReviewSettings, "delayHours">, timeZone: string): number {
  return nextSendTime(eventMs + settings.delayHours * 3_600_000, timeZone);
}

// ── Messages ────────────────────────────────────────────────────────────────

export function renderReviewTemplate(tpl: string, vars: { firstName: string | null; company: string; link: string }): string {
  return tpl
    .replace(/\{\{\s*first_name\s*\}\}/g, vars.firstName?.trim() || "there")
    .replace(/\{\{\s*company\s*\}\}/g, vars.company)
    .replace(/\{\{\s*link\s*\}\}/g, vars.link);
}

// ── The send-time decision ──────────────────────────────────────────────────

export interface SendCandidate {
  source: "job_done" | "invoice_paid" | "manual";
  /** Staff chose the channel by hand (manual asks only). */
  channel?: "sms" | "email" | null;
}

export interface SendFacts {
  settings: ReviewSettings;
  reviewUrl: string | null;
  contact: { phone: string | null; email: string | null; smsOptOut: boolean; emailOptOut: boolean };
  /** The job is still marked done / the invoice is still paid (always true for manual). */
  stillValid: boolean;
  /** Another ask already went to this customer inside the cooldown. */
  askedRecently: boolean;
  emailConfigured: boolean;
  nowMs: number;
  timeZone: string;
}

export type SendPlan =
  | { action: "send"; channel: "sms" | "email"; to: string }
  | { action: "defer"; until: number }
  | { action: "skip"; reason: string }
  | { action: "cancel"; reason: string };

export function planSend(c: SendCandidate, f: SendFacts): SendPlan {
  const auto = c.source !== "manual";
  if (auto && !f.settings.enabled) return { action: "cancel", reason: "Review requests were turned off before this went out." };
  if (!f.reviewUrl) return { action: "skip", reason: "No review link is set (Settings → Reviews)." };
  if (!f.stillValid) {
    return {
      action: "skip",
      reason: c.source === "invoice_paid" ? "The invoice is no longer marked paid." : "The job is no longer marked done.",
    };
  }
  if (auto && f.askedRecently) {
    return { action: "skip", reason: `Already asked within the last ${f.settings.cooldownDays} days.` };
  }
  if (auto) {
    const at = nextSendTime(f.nowMs, f.timeZone);
    if (at > f.nowMs) return { action: "defer", until: at };
  }

  const phone = f.contact.phone?.trim() || null;
  const email = f.contact.email?.trim() || null;
  const smsOk = Boolean(phone) && !f.contact.smsOptOut;
  const emailOk = Boolean(email) && !f.contact.emailOptOut && f.emailConfigured;
  const pref = c.channel ?? f.settings.channel;

  if (pref === "sms" || pref === "sms_or_email") {
    if (smsOk) return { action: "send", channel: "sms", to: phone! };
    if (pref === "sms") return { action: "skip", reason: !phone ? "No mobile number on file." : "This customer has opted out of texts." };
  }
  if (emailOk) return { action: "send", channel: "email", to: email! };
  if (!phone && !email) return { action: "skip", reason: "No mobile number or email on file." };
  if (!email && pref === "email") return { action: "skip", reason: "No email address on file." };
  if (email && !f.emailConfigured) return { action: "skip", reason: "Email sending isn't set up." };
  return { action: "skip", reason: "This customer has opted out of messages." };
}
