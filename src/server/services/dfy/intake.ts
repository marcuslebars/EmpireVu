// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): done-for-you quick-setup intake.
// Created from provisioning (billing worker) and the scheduler, neither of which has a user
// session; read and answered from the public /setup/:token page, where the unguessable token
// is the credential. Every read/write is scoped to the ONE company the token belongs to
// (organization_id + company_id taken from the intake row, never from the request).
// See docs/done-for-you.md, "Intake & enrichment".
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  BUSINESS_PHONE_KINDS,
  NEW_SERVICE_UNIT_KEYS,
  PHONE_CARRIER_KEYS,
  priceUnitLabel,
  type IntakeAnswers,
} from "@/lib/setup-intake";
import type { Tables } from "@/server/db/database.types";
import { isBlockedHost, normalizeWebsiteUrl } from "@/server/net/safe-fetch";
import { ValidationError } from "@/server/organizations/context";
import type { AdminClient } from "@/server/services/crankleads/purchases";
import { inLiveWindow } from "@/server/services/crankleads/followup-schedule";
import { loadOwnerTextBlock } from "@/server/services/dfy/eligibility";
import { isPlaceId, isPlacesConfigured } from "@/server/services/dfy/places";
import { appBaseUrlFor, loadOrganizationBrand, type PlatformBrand, type PlatformBrandKey } from "@/server/services/platform-brand";
import { toE164 } from "@/server/services/retell/payload";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  deliverMessage as defaultDeliverMessage,
  type DeliverMessageInput,
  type DeliverMessageResult,
} from "@/server/services/workflow-engine/messaging";

export type SetupIntake = Tables<"setup_intakes">;
type CompanyRow = Pick<
  Tables<"companies">,
  "id" | "organization_id" | "name" | "owner_email" | "owner_phone_e164" | "timezone" | "business_phone_kind" | "business_phone_carrier"
>;

/** Text + email tries before the retry sweep gives up (an operator picks it up from there). */
export const MAX_SEND_ATTEMPTS = 3;
/** Retry sweep: wait this long between tries. */
export const SEND_RETRY_AFTER_MS = 10 * 60 * 1000;
/** Retry sweep: only intakes this recent (older ones are the operator's). */
const SEND_RETRY_HORIZON_MS = 3 * 24 * 60 * 60 * 1000;
const FALLBACK_TIMEZONE = "America/Toronto";

/** Statuses after the buyer submitted answers. */
export const ANSWERED_STATUSES = ["submitted", "enriching", "enriched", "failed"] as const;

// ── Tokens + links ───────────────────────────────────────────────────────────

/** 24 random bytes, base64url → 32 URL-safe characters. */
export function newSetupToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isSetupToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);
}

export function setupUrlFor(brand: PlatformBrand | PlatformBrandKey, token: string): string {
  return `${appBaseUrlFor(brand)}/setup/${token}`;
}

function nowIso(nowMs?: number): string {
  return new Date(nowMs ?? Date.now()).toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Create (idempotent: one intake per company) ──────────────────────────────

async function findIntakeForCompany(admin: AdminClient, companyId: string): Promise<SetupIntake | null> {
  const { data, error } = await admin.from("setup_intakes").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw new Error(`setup_intakes lookup failed: ${error.message}`);
  return (data as SetupIntake | null) ?? null;
}

/**
 * The company's intake — created on first call, the same row (same token, same link) on
 * every call after. Safe under a race: the unique company_id makes the loser re-read.
 */
export async function ensureSetupIntake(
  admin: AdminClient,
  input: { organizationId: string; companyId: string },
): Promise<{ intake: SetupIntake; url: string; brand: PlatformBrand }> {
  const brand = await loadOrganizationBrand(admin, input.organizationId);
  let intake = await findIntakeForCompany(admin, input.companyId);
  if (!intake) {
    const { data, error } = await admin
      .from("setup_intakes")
      .insert({
        organization_id: input.organizationId,
        company_id: input.companyId,
        token: newSetupToken(),
        status: "pending",
        answers: {},
        enrichment: {},
        send_attempts: 0,
        enrich_attempts: 0,
      })
      .select("*")
      .single();
    if (error) {
      if ((error as { code?: string }).code !== "23505") throw new Error(`setup_intakes insert failed: ${error.message}`);
      intake = await findIntakeForCompany(admin, input.companyId);
    } else {
      intake = data as SetupIntake;
    }
  }
  if (!intake) throw new Error("setup intake could not be created");
  if (intake.organization_id !== input.organizationId) {
    throw new Error(`setup intake for company ${input.companyId} belongs to another organization`);
  }
  return { intake, url: setupUrlFor(brand, intake.token), brand };
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function renderSetupSms(input: { brandName: string; url: string }): string {
  return `${input.brandName}: you're in. 60 seconds and we'll set the rest up for you: ${input.url}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderSetupEmail(input: { brandName: string; businessName: string; url: string }): {
  subject: string;
  body: string;
  html: string;
  fromName: string;
} {
  const subject = "Your 60-second setup link";
  const body = [
    "You're in.",
    "",
    `Answer 3 quick questions (about 60 seconds) and we'll set up the rest of ${input.businessName} for you — your hours, services, prices and website page:`,
    input.url,
    "",
    "No login needed. We'll text you when everything's built.",
    "",
    "Questions? Just reply to this email.",
    "",
    `— The ${input.brandName} team`,
  ].join("\n");
  const html = [
    "<p>You're in.</p>",
    `<p>Answer 3 quick questions (about 60 seconds) and we'll set up the rest of <strong>${escapeHtml(input.businessName)}</strong> for you — your hours, services, prices and website page.</p>`,
    `<p><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">Start the 60-second setup</a></p>`,
    `<p style="font-size:12px;color:#6b7280">No login needed. Or open: ${escapeHtml(input.url)}</p>`,
    `<p>Questions? Just reply to this email.</p><p>— The ${escapeHtml(input.brandName)} team</p>`,
  ].join("\n");
  return { subject, body, html, fromName: input.brandName };
}

// ── Send ─────────────────────────────────────────────────────────────────────

export interface IntakeSendDeps {
  deliver: (input: DeliverMessageInput) => Promise<DeliverMessageResult>;
  now: () => number;
}

const defaultSendDeps: IntakeSendDeps = { deliver: defaultDeliverMessage, now: () => Date.now() };

/** always: text + email. if_sms_fails: email only when the text can't go (no number / failed). never: text only. */
export type EmailBackupMode = "always" | "if_sms_fails" | "never";

export type IntakeSendOutcome =
  | { status: "sent"; sms: boolean; email: boolean; url: string; quietHours?: boolean }
  /** Outside 08:00–21:00 their time: the text waits for the retry sweep (from 08:00). */
  | { status: "queued"; email: boolean; url: string }
  | { status: "texts_stopped"; url: string }
  | { status: "already_sent"; url: string }
  | { status: "failed"; error: string; url: string }
  | { status: "busy"; url: string };

async function loadCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<CompanyRow> {
  const { data, error } = await admin
    .from("companies")
    .select("id, organization_id, name, owner_email, owner_phone_e164, timezone, business_phone_kind, business_phone_carrier")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`company lookup failed: ${error.message}`);
  if (!data) throw new Error(`company ${companyId} not found in organization ${organizationId}`);
  return data as CompanyRow;
}

/**
 * Claim one send attempt (send_attempts n → n+1 only if still n), so two workers can never
 * both text the buyer for the same try.
 */
async function claimSendAttempt(admin: AdminClient, intake: SetupIntake, nowMs: number): Promise<SetupIntake | null> {
  const { data, error } = await admin
    .from("setup_intakes")
    .update({ send_attempts: intake.send_attempts + 1, updated_at: nowIso(nowMs) })
    .eq("id", intake.id)
    .eq("send_attempts", intake.send_attempts)
    .select("*");
  if (error) throw new Error(`setup_intakes claim failed: ${error.message}`);
  const row = ((data ?? []) as SetupIntake[])[0];
  return row ?? null;
}

async function deliverClaimed(
  admin: AdminClient,
  intake: SetupIntake,
  url: string,
  brand: PlatformBrand,
  emailBackup: EmailBackupMode,
  deps: IntakeSendDeps,
  /** false outside 08:00–21:00 their time: email only, the text waits (no SMS error recorded). */
  allowSms = true,
): Promise<IntakeSendOutcome> {
  const nowMs = deps.now();
  const company = await loadCompany(admin, intake.organization_id, intake.company_id);
  const ctx: TenantServiceContext = { actorProfileId: null, organizationId: intake.organization_id, supabase: admin };
  const base = { context: ctx, companyId: company.id, contactId: null, consentContact: null } as const;
  const errors: string[] = [];

  let smsSent = Boolean(intake.sms_sent_at);
  if (!smsSent && allowSms) {
    if (!company.owner_phone_e164) {
      errors.push("no owner phone");
    } else {
      try {
        const result = await deps.deliver({
          ...base,
          channel: "sms",
          to: company.owner_phone_e164,
          body: renderSetupSms({ brandName: brand.name, url }),
          smsFrom: "platform",
        });
        if (result.status === "sent") smsSent = true;
        else errors.push(`sms ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
      } catch (err) {
        errors.push(`sms threw: ${errorMessage(err)}`);
      }
    }
  }

  let emailSent = Boolean(intake.email_sent_at);
  const wantEmail = emailBackup === "always" || (emailBackup === "if_sms_fails" && !smsSent && allowSms);
  if (!emailSent && wantEmail) {
    if (!company.owner_email) {
      errors.push("no owner email");
    } else {
      const email = renderSetupEmail({ brandName: brand.name, businessName: company.name, url });
      try {
        const result = await deps.deliver({
          ...base,
          channel: "email",
          to: company.owner_email,
          subject: email.subject,
          body: email.body,
          html: email.html,
          fromName: email.fromName,
        });
        if (result.status === "sent") emailSent = true;
        else errors.push(`email ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
      } catch (err) {
        errors.push(`email threw: ${errorMessage(err)}`);
      }
    }
  }

  const stamp = nowIso(nowMs);
  const patch: Partial<SetupIntake> = { updated_at: stamp, last_error: errors.length ? errors.join("; ").slice(0, 1000) : null };
  if (smsSent && !intake.sms_sent_at) patch.sms_sent_at = stamp;
  if (emailSent && !intake.email_sent_at) patch.email_sent_at = stamp;
  const { error } = await admin.from("setup_intakes").update(patch).eq("id", intake.id);
  if (error) throw new Error(`setup_intakes update failed: ${error.message}`);

  if (!allowSms) {
    console.log(`[dfy/intake] outside texting hours for company ${intake.company_id}: email=${emailSent}, the text waits for 08:00`);
    return { status: "sent", sms: false, email: emailSent, url, quietHours: true };
  }

  // Delivered = the text went out, or (no usable phone) the email did. Only a pending
  // intake moves to 'sent' — never regress one the buyer already opened or answered.
  const delivered = smsSent || (emailSent && !company.owner_phone_e164);
  if (delivered) {
    const { error: statusError } = await admin
      .from("setup_intakes")
      .update({ status: "sent", sent_at: stamp })
      .eq("id", intake.id)
      .eq("status", "pending");
    if (statusError) throw new Error(`setup_intakes status update failed: ${statusError.message}`);
    console.log(`[dfy/intake] setup link sent for company ${intake.company_id} (sms=${smsSent}, email=${emailSent})`);
    return { status: "sent", sms: smsSent, email: emailSent, url };
  }
  console.error(`[dfy/intake] setup link NOT delivered for company ${intake.company_id} (try ${intake.send_attempts}): ${patch.last_error}`);
  return { status: "failed", error: patch.last_error ?? "not delivered", url };
}

/**
 * Create (once) and send the buyer their quick-setup link: a text from the platform number
 * plus an email backup. Idempotent — an intake already sent is not re-sent. A failure is
 * recorded (last_error, status stays 'pending') for processPendingIntakeSends to retry;
 * it never throws for a delivery problem.
 */
export async function createAndSendSetupIntake(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; emailBackup?: EmailBackupMode },
  depsOverride: Partial<IntakeSendDeps> = {},
): Promise<IntakeSendOutcome> {
  const deps: IntakeSendDeps = { ...defaultSendDeps, ...depsOverride };
  const { intake, url, brand } = await ensureSetupIntake(admin, input);
  if (intake.status !== "pending") return { status: "already_sent", url };
  if (intake.send_attempts >= MAX_SEND_ATTEMPTS) return { status: "failed", error: intake.last_error ?? "gave up", url };
  if (await loadOwnerTextBlock(admin, intake.organization_id, intake.company_id)) return { status: "texts_stopped", url };
  const company = await loadCompany(admin, intake.organization_id, intake.company_id);
  if (!inLiveWindow(company.timezone || FALLBACK_TIMEZONE, deps.now())) {
    // Bought at night: no text now — processPendingIntakeSends sends it from 08:00 their time
    // (the welcome email already carries the link). Only when the welcome email failed does an
    // email copy go now.
    if ((input.emailBackup ?? "always") !== "always") return { status: "queued", email: false, url };
    const claimed = await claimSendAttempt(admin, intake, deps.now());
    if (!claimed) return { status: "busy", url };
    const out = await deliverClaimed(admin, claimed, url, brand, "always", deps, false);
    return { status: "queued", email: out.status === "sent" && out.email, url };
  }
  const claimed = await claimSendAttempt(admin, intake, deps.now());
  if (!claimed) return { status: "busy", url };
  return deliverClaimed(admin, claimed, url, brand, input.emailBackup ?? "always", deps);
}

/**
 * Operator resend (concierge "Resend quick-setup link"): text + email the SAME link again now,
 * whatever was sent before (stamps sms_sent_at / email_sent_at afresh, so follow-up reminders
 * keep quiet for a while after it). A pending intake moves to 'sent'; an answered one keeps its
 * status (re-opening the link lets them update their answers).
 */
export async function resendSetupIntake(
  admin: AdminClient,
  input: { organizationId: string; companyId: string },
  depsOverride: Partial<IntakeSendDeps> = {},
): Promise<IntakeSendOutcome> {
  const deps: IntakeSendDeps = { ...defaultSendDeps, ...depsOverride };
  const { intake, url, brand } = await ensureSetupIntake(admin, input);
  if (await loadOwnerTextBlock(admin, intake.organization_id, intake.company_id)) return { status: "texts_stopped", url };
  const company = await loadCompany(admin, intake.organization_id, intake.company_id);
  // Outside 08:00–21:00 their time only the email goes (the caller warns the operator).
  const allowSms = inLiveWindow(company.timezone || FALLBACK_TIMEZONE, deps.now());
  return deliverClaimed(admin, { ...intake, sms_sent_at: null, email_sent_at: null }, url, brand, "always", deps, allowSms);
}

/**
 * Scheduler sweep: retry setup links that never went out (status 'pending', fewer than
 * MAX_SEND_ATTEMPTS tries, last try ≥ 10 min ago), daytime only (08:00–21:00 company time).
 * Email goes as a backup when the text can't. Self-guarded: never throws.
 */
export async function processPendingIntakeSends(
  admin: AdminClient,
  options: { nowMs?: number; limit?: number } = {},
  depsOverride: Partial<IntakeSendDeps> = {},
): Promise<{ attempted: number; sent: number }> {
  const deps: IntakeSendDeps = { ...defaultSendDeps, ...depsOverride };
  const nowMs = options.nowMs ?? deps.now();
  let attempted = 0;
  let sent = 0;
  try {
    const { data, error } = await admin
      .from("setup_intakes")
      .select("*")
      .eq("status", "pending")
      .lt("send_attempts", MAX_SEND_ATTEMPTS)
      .gte("created_at", nowIso(nowMs - SEND_RETRY_HORIZON_MS))
      .lte("updated_at", nowIso(nowMs - SEND_RETRY_AFTER_MS))
      .order("created_at", { ascending: true })
      .limit(options.limit ?? 25);
    if (error) throw new Error(error.message);
    for (const intake of (data ?? []) as SetupIntake[]) {
      try {
        const company = await loadCompany(admin, intake.organization_id, intake.company_id);
        if (!inLiveWindow(company.timezone || FALLBACK_TIMEZONE, nowMs)) continue;
        if (await loadOwnerTextBlock(admin, intake.organization_id, intake.company_id)) continue;
        const claimed = await claimSendAttempt(admin, intake, nowMs);
        if (!claimed) continue;
        attempted += 1;
        const brand = await loadOrganizationBrand(admin, intake.organization_id);
        const outcome = await deliverClaimed(admin, claimed, setupUrlFor(brand, intake.token), brand, "if_sms_fails", {
          ...deps,
          now: () => nowMs,
        });
        if (outcome.status === "sent") sent += 1;
      } catch (err) {
        console.error(`[dfy/intake] retry failed for intake ${intake.id}: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    console.error(`[dfy/intake] retry sweep failed: ${errorMessage(err)}`);
  }
  return { attempted, sent };
}

// ── Public page: view + answers ──────────────────────────────────────────────

/** The intake for a token, or null (bad format / unknown). One answer for every miss. */
export async function findIntakeByToken(admin: AdminClient, token: string): Promise<SetupIntake | null> {
  if (!isSetupToken(token)) return null;
  const { data, error } = await admin.from("setup_intakes").select("*").eq("token", token).maybeSingle();
  if (error) throw new Error(`setup_intakes lookup failed: ${error.message}`);
  return (data as SetupIntake | null) ?? null;
}

export interface SetupServiceView {
  id: string;
  label: string;
  unitLabel: string;
  priceCents: number | null;
}

export interface SetupIntakeView {
  brand: PlatformBrandKey;
  businessName: string;
  /** "open": not answered yet. "submitted": answered (we're building, or built). */
  state: "open" | "submitted";
  placesEnabled: boolean;
  phone: { number: string; kind: string | null; carrier: string | null };
  services: SetupServiceView[];
  answers: IntakeAnswers | null;
  submittedAt: string | null;
}

/** "+17055550101" → "(705) 555-0101". */
export function formatNanp(e164: string | null | undefined): string {
  const m = e164?.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 ?? "";
}

type CatalogRow = Pick<Tables<"service_catalog_items">, "id" | "label" | "pricing_type" | "unit_label" | "rate_cents" | "sort_order">;

async function loadCatalog(admin: AdminClient, intake: SetupIntake): Promise<CatalogRow[]> {
  const { data, error } = await admin
    .from("service_catalog_items")
    .select("id, label, pricing_type, unit_label, rate_cents, sort_order")
    .eq("organization_id", intake.organization_id)
    .eq("company_id", intake.company_id)
    .order("sort_order", { ascending: true })
    .limit(60);
  if (error) throw new Error(`catalog lookup failed: ${error.message}`);
  return ((data ?? []) as CatalogRow[]).slice().sort((a, b) => a.sort_order - b.sort_order);
}

export function readAnswers(raw: unknown): IntakeAnswers | null {
  const parsed = intakeAnswersSchema.safeParse(raw);
  return parsed.success ? (parsed.data as IntakeAnswers) : null;
}

async function buildView(admin: AdminClient, intake: SetupIntake): Promise<SetupIntakeView> {
  const [company, brand, catalog] = await Promise.all([
    loadCompany(admin, intake.organization_id, intake.company_id),
    loadOrganizationBrand(admin, intake.organization_id),
    loadCatalog(admin, intake),
  ]);
  const answers = (ANSWERED_STATUSES as readonly string[]).includes(intake.status) ? readAnswers(intake.answers) : null;
  const answered = new Map((answers?.prices.items ?? []).filter((i) => i.id).map((i) => [i.id as string, i.priceCents]));
  return {
    brand: brand.key,
    businessName: company.name,
    state: answers ? "submitted" : "open",
    placesEnabled: isPlacesConfigured(),
    phone: {
      number: answers ? formatNanp(answers.phone.number) : formatNanp(company.owner_phone_e164),
      kind: answers?.phone.kind ?? company.business_phone_kind ?? null,
      carrier: answers?.phone.carrier ?? company.business_phone_carrier ?? null,
    },
    services: catalog.map((item) => ({
      id: item.id,
      label: item.label,
      unitLabel: priceUnitLabel(item.pricing_type, item.unit_label),
      priceCents: answered.get(item.id) ?? (item.rate_cents > 0 ? item.rate_cents : null),
    })),
    answers,
    submittedAt: answers ? intake.submitted_at : null,
  };
}

/** GET /api/public/setup/:token — the page's state; marks the intake opened the first time. */
export async function getSetupView(admin: AdminClient, token: string, nowMs: number = Date.now()): Promise<SetupIntakeView | null> {
  const intake = await findIntakeByToken(admin, token);
  if (!intake) return null;
  if (!intake.opened_at) {
    const stamp = nowIso(nowMs);
    await admin.from("setup_intakes").update({ opened_at: stamp, updated_at: stamp }).eq("id", intake.id).is("opened_at", null);
    await admin.from("setup_intakes").update({ status: "opened" }).eq("id", intake.id).in("status", ["pending", "sent"]);
  }
  return buildView(admin, intake);
}

// ── Answer validation ────────────────────────────────────────────────────────

const PRICE_MAX_CENTS = 100_000_000;

const listingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("google"),
    placeId: z.string().refine(isPlaceId, { message: "Pick your business from the list again." }),
    name: z.string().trim().min(1, { message: "Pick your business from the list again." }).max(200),
    address: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  }),
  z.object({
    kind: z.literal("website"),
    url: z
      .string()
      .trim()
      .max(500, { message: "That website address is too long." })
      .transform((v, ctx) => {
        const url = normalizeWebsiteUrl(v);
        if (!url || isBlockedHost(new URL(url).hostname)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "That website address doesn't look right — try something like yourbusiness.ca." });
          return z.NEVER;
        }
        return url;
      }),
  }),
  z.object({ kind: z.literal("none") }),
]);

const phoneSchema = z.object({
  number: z.string().transform((v, ctx) => {
    const e164 = toE164(v);
    if (!e164 || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter your business phone number with the area code, like 705-555-0123." });
      return z.NEVER;
    }
    return e164;
  }),
  kind: z.enum(BUSINESS_PHONE_KINDS, { errorMap: () => ({ message: "Tell us if your business line is a cell, landline or internet phone." }) }),
  carrier: z.enum(PHONE_CARRIER_KEYS, { errorMap: () => ({ message: "Pick your phone company (or “Other / not sure”)." }) }),
});

const priceItemSchema = z.object({
  id: z.string().uuid({ message: "One of the services changed — reload the page and try again." }).optional(),
  label: z.string().trim().min(1, { message: "Give each service you add a name." }).max(120, { message: "Keep service names under 120 characters." }),
  priceCents: z
    .number({ invalid_type_error: "Prices need to be numbers, like 150 or 89.50." })
    .int({ message: "Prices need to be numbers, like 150 or 89.50." })
    .positive({ message: "Prices need to be more than $0 — leave a box empty to skip it." })
    .max(PRICE_MAX_CENTS, { message: "That price looks too big — check it and try again." }),
  unit: z.enum(NEW_SERVICE_UNIT_KEYS).optional(),
});

export const intakeAnswersSchema = z.object({
  listing: listingSchema,
  phone: phoneSchema,
  prices: z
    .object({
      skipped: z.boolean().default(false),
      items: z.array(priceItemSchema).max(60, { message: "That's a lot of services — add the rest later in the app." }).default([]),
    })
    .transform((p) => (p.skipped ? { skipped: true, items: [] } : p)),
});

/** Validate the page's answers. Throws ValidationError with the first plain-English problem. */
export function parseIntakeAnswers(raw: unknown): IntakeAnswers {
  const parsed = intakeAnswersSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const custom = issue?.message ?? null;
    throw new ValidationError(
      custom && !/^(Required|Invalid|Expected)/.test(custom) ? custom : "Something in the form didn't look right — check it and try again.",
    );
  }
  return parsed.data as IntakeAnswers;
}

/**
 * POST /api/public/setup/:token — save the answers (first time or an update) and queue
 * enrichment (status → 'submitted'; processPendingEnrichments picks it up). Service ids must
 * belong to THIS company; added services are de-duplicated by name.
 */
export async function submitSetupAnswers(
  admin: AdminClient,
  token: string,
  raw: unknown,
  nowMs: number = Date.now(),
): Promise<SetupIntakeView | null> {
  const intake = await findIntakeByToken(admin, token);
  if (!intake) return null;
  const answers = parseIntakeAnswers(raw);

  const catalog = await loadCatalog(admin, intake);
  const known = new Set(catalog.map((c) => c.id));
  const seen = new Set<string>();
  const items = [];
  for (const item of answers.prices.items) {
    if (item.id && !known.has(item.id)) throw new ValidationError("One of the services changed — reload the page and try again.");
    const key = item.id ?? `new:${item.label.toLowerCase().replace(/\s+/g, " ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item.id ? { id: item.id, label: catalog.find((c) => c.id === item.id)?.label ?? item.label, priceCents: item.priceCents } : { ...item, unit: item.unit ?? "flat" });
  }
  const clean: IntakeAnswers = { ...answers, prices: { skipped: answers.prices.skipped, items } };

  const stamp = nowIso(nowMs);
  const { error } = await admin
    .from("setup_intakes")
    .update({
      answers: clean as unknown as SetupIntake["answers"],
      status: "submitted",
      submitted_at: stamp,
      opened_at: intake.opened_at ?? stamp,
      enrich_attempts: 0,
      last_error: null,
      updated_at: stamp,
    })
    .eq("id", intake.id)
    .eq("token", token);
  if (error) throw new Error(`setup_intakes answer write failed: ${error.message}`);
  console.log(`[dfy/intake] answers ${intake.submitted_at ? "updated" : "received"} for company ${intake.company_id}`);
  return buildView(admin, { ...intake, answers: clean as unknown as SetupIntake["answers"], status: "submitted", submitted_at: stamp });
}
