import type { Inserts, Tables } from "@/server/db/database.types";
import { sendEmail } from "@/server/outbound/email";
import { sendSms } from "@/server/outbound/sms";
import type { TenantServiceContext } from "@/server/services/shared";
import { isPlatformOptedOut } from "@/server/services/platform-opt-out";
import { recordUsageSafe } from "@/server/services/usage";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";

/**
 * Messaging primitives for the send_sms / send_email / notify_owner workflow actions
 * (Task 8): CASL consent, owner routing, the one-time STOP footer, and delivery that
 * always writes message_log + usage_events and (for customer messages) emits a
 * contact.*_sent activity event WITHOUT re-triggering workflows.
 */
export type MessageChannel = "sms" | "email";

function providerFor(channel: MessageChannel): string {
  return channel === "sms" ? "twilio" : "resend";
}

// ── Consent (CASL / CRTC) ─────────────────────────────────────────────────────
// Implied consent (an inquiry) is valid for 6 months; express consent does not expire.
// See docs/messaging-compliance.md.
const IMPLIED_CONSENT_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const EXPRESS_CONSENT_SOURCES = new Set(["express", "express_optin", "double_optin"]);

export type ConsentContact = Pick<
  Tables<"contacts">,
  "sms_opt_out_at" | "email_opt_out_at" | "sms_consent_at" | "consent_source"
>;

export interface ConsentResult {
  ok: boolean;
  reason?: "opted_out" | "no_consent" | "consent_expired";
}

export function checkConsent(
  contact: ConsentContact,
  channel: MessageChannel,
  now: number = Date.now(),
): ConsentResult {
  const optOut = channel === "sms" ? contact.sms_opt_out_at : contact.email_opt_out_at;
  if (optOut) return { ok: false, reason: "opted_out" };
  if (contact.consent_source && EXPRESS_CONSENT_SOURCES.has(contact.consent_source)) return { ok: true };
  if (!contact.sms_consent_at) return { ok: false, reason: "no_consent" };
  const age = now - Date.parse(contact.sms_consent_at);
  if (Number.isFinite(age) && age > IMPLIED_CONSENT_MS) return { ok: false, reason: "consent_expired" };
  return { ok: true };
}

// ── Owner routing ─────────────────────────────────────────────────────────────
export interface OwnerContacts {
  email: string | null;
  phone: string | null;
}

export interface ResolveOwnerOptions {
  /**
   * Allow the deployment-wide OWNER_EMAIL as a last resort — and then ONLY for the house org.
   * Default true (owner alerts / digest). Tenant reports that must never reach the platform
   * inbox (the monthly scorecard) pass false.
   */
  allowPlatformFallback?: boolean;
}

/** Slug of the house/platform org (A1) — same source as lead intake (LEAD_INTAKE_ORG_SLUG). */
function houseOrgSlug(): string {
  return process.env.LEAD_INTAKE_ORG_SLUG ?? "a1-group";
}

/**
 * Is this org the platform's own ("house") org? plan='internal' (billing's own marker) or the
 * lead-intake org slug (A1). Only the house org may route owner mail to the global OWNER_EMAIL:
 * that inbox belongs to the platform operator, so using it for any other tenant would email
 * that tenant's data to the platform (cross-tenant leak) and the tenant would never get it.
 */
export async function isHouseOrganization(context: TenantServiceContext): Promise<boolean> {
  const { data } = await context.supabase
    .from("organizations")
    .select("plan, slug")
    .eq("id", context.organizationId)
    .maybeSingle();
  const org = data as { plan: string | null; slug: string | null } | null;
  return Boolean(org && (org.plan === "internal" || org.slug === houseOrgSlug()));
}

/**
 * Owner recipients for owner-facing messages (alerts, digest, scorecard).
 *
 *  - email: companies.owner_email → (house org only, when allowed) OWNER_EMAIL → the org's
 *    owner, then admin, user email. A tenant org NEVER falls back to OWNER_EMAIL.
 *    The house org (A1) keeps its original order (OWNER_EMAIL before the org owner's profile)
 *    so its alerts keep going where they always have.
 *  - phone: companies.owner_phone_e164 only.
 */
export async function resolveOwnerContacts(
  context: TenantServiceContext,
  company: Pick<Tables<"companies">, "owner_email" | "owner_phone_e164"> | null,
  options: ResolveOwnerOptions = {},
): Promise<OwnerContacts> {
  let email = company?.owner_email?.trim() || null;
  const phone = company?.owner_phone_e164?.trim() || null;
  if (!email && options.allowPlatformFallback !== false) {
    const platformEmail = process.env.OWNER_EMAIL?.trim() || null;
    if (platformEmail && (await isHouseOrganization(context).catch(() => false))) email = platformEmail;
  }
  if (!email) email = await orgOwnerEmail(context);
  return { email, phone };
}

/** The org's owner's email, else an admin's (owners first; deterministic by role then id). */
export async function orgOwnerEmail(context: TenantServiceContext): Promise<string | null> {
  const { data: memberships } = await context.supabase
    .from("organization_memberships")
    .select("profile_id, role")
    .eq("organization_id", context.organizationId)
    .in("role", ["owner", "admin"])
    .limit(50);
  const ranked = ((memberships ?? []) as Array<{ profile_id: string; role: string }>)
    .slice()
    .sort((a, b) => (a.role === b.role ? a.profile_id.localeCompare(b.profile_id) : a.role === "owner" ? -1 : 1));
  for (const membership of ranked) {
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("email")
      .eq("id", membership.profile_id)
      .maybeSingle();
    const email = (profile as { email: string | null } | null)?.email?.trim();
    if (email) return email;
  }
  return null;
}

// ── STOP footer (first outbound SMS to a contact) ────────────────────────────
export const STOP_FOOTER = "Reply STOP to opt out";

async function isFirstSmsToContact(context: TenantServiceContext, contactId: string): Promise<boolean> {
  const { data } = await context.supabase
    .from("message_log")
    .select("id")
    .eq("organization_id", context.organizationId)
    .eq("contact_id", contactId)
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .eq("status", "sent")
    .limit(1);
  return (data ?? []).length === 0;
}

// ── message_log ───────────────────────────────────────────────────────────────
type MessageLogRow = Omit<Inserts<"message_log">, "organization_id">;

/** Best-effort: a logging failure must never fail a message that already went out. */
async function writeMessageLog(context: TenantServiceContext, row: MessageLogRow): Promise<void> {
  try {
    const { error } = await context.supabase
      .from("message_log")
      .insert({ ...row, organization_id: context.organizationId });
    if (error) throw error;
  } catch (err) {
    console.error("[messaging] message_log write failed:", err instanceof Error ? err.message : err);
  }
}

// ── Sending number ────────────────────────────────────────────────────────────
/**
 * The company's own Twilio number to send SMS from (its missed-call catcher first, then any
 * other active Twilio number), so a text-back comes from the number the customer called and
 * their reply routes back to this company (inbound SMS resolves the tenant by `To`). Null →
 * the deployment-wide TWILIO_FROM_NUMBER. Best-effort: a lookup failure never blocks a send.
 */
export async function resolveCompanySmsFrom(
  context: TenantServiceContext,
  companyId: string | null,
): Promise<string | null> {
  if (!companyId) return null;
  try {
    const { data, error } = await context.supabase
      .from("voice_numbers")
      .select("phone_e164, mode")
      .eq("organization_id", context.organizationId)
      .eq("company_id", companyId)
      .eq("provider", "twilio")
      .eq("active", true)
      .limit(5);
    if (error) throw error;
    const rows = (data ?? []) as Array<Pick<Tables<"voice_numbers">, "phone_e164" | "mode">>;
    const catcher = rows.find((row) => row.mode === "missed_call_catcher");
    return (catcher ?? rows[0])?.phone_e164 ?? null;
  } catch (err) {
    console.error("[messaging] sending-number lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Deliver ───────────────────────────────────────────────────────────────────
export interface DeliverMessageInput {
  context: TenantServiceContext;
  channel: MessageChannel;
  /** Resolved recipient (phone for sms, email for email). Null → nothing to send. */
  to: string | null;
  body: string;
  /** Optional HTML alternative for email (the `body` stays the plain-text part). Ignored for SMS. */
  html?: string | null;
  companyId: string | null;
  /** The contact being messaged, or null for owner/literal recipients. */
  contactId: string | null;
  /** Consent is checked only when messaging a known contact. */
  consentContact: ConsentContact | null;
  subject?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  workflowRunId?: string | null;
  /**
   * SMS sender. "company" (default): the company's own Twilio number (catcher first), else
   * TWILIO_FROM_NUMBER. "platform": always TWILIO_FROM_NUMBER — for platform messages to the
   * owner (CrankLeads setup reminders), so a STOP reply to them can never block the company's
   * own number from texting the owner its lead alerts.
   */
  smsFrom?: "company" | "platform";
  /**
   * Who wrote it, stored on message_log.sent_by — "sms_agent" for the AI front desk (the inbox
   * labels those "Assistant"). Omit for staff / automation messages.
   */
  sentBy?: string | null;
}

export interface DeliverMessageResult {
  status: "sent" | "failed" | "blocked";
  reason?: string;
  providerRef?: string | null;
  /** The body actually sent (may include the STOP footer). */
  body: string;
}

export async function deliverMessage(input: DeliverMessageInput): Promise<DeliverMessageResult> {
  const { context, channel, companyId, contactId } = input;
  const base = {
    channel,
    company_id: companyId,
    contact_id: contactId,
    to_addr: input.to,
    subject: input.subject ?? null,
    direction: "outbound" as const,
    provider: providerFor(channel),
    workflow_run_id: input.workflowRunId ?? null,
    ...(input.sentBy ? { sent_by: input.sentBy } : {}),
  };

  if (!input.to) {
    await writeMessageLog(context, { ...base, body: input.body, status: "blocked", error: "no_recipient" });
    return { status: "blocked", reason: "no_recipient", body: input.body };
  }

  // A template whose data didn't resolve (e.g. {{ call.owner_summary }} on a call we have
  // no record of) renders to nothing. Never send a blank text or email.
  if (!input.body.trim()) {
    await writeMessageLog(context, { ...base, body: input.body, status: "blocked", error: "empty_body" });
    return { status: "blocked", reason: "empty_body", body: input.body };
  }

  // A STOP to the platform number stops every platform text to that phone (owner channel,
  // setup reminders, forwarding / page texts, the weekly report) — platform-opt-out.ts.
  if (channel === "sms" && input.smsFrom === "platform" && (await isPlatformOptedOut(context.supabase, input.to))) {
    await writeMessageLog(context, { ...base, body: input.body, status: "blocked", error: "platform_opted_out" });
    return { status: "blocked", reason: "platform_opted_out", body: input.body };
  }

  // Consent — only for a known contact (owner/literal recipients are the author's choice).
  if (input.consentContact) {
    const consent = checkConsent(input.consentContact, channel);
    if (!consent.ok) {
      await writeMessageLog(context, { ...base, body: input.body, status: "blocked", error: consent.reason });
      return { status: "blocked", reason: consent.reason, body: input.body };
    }
  }

  // One-time STOP footer on the first SMS to a contact.
  let body = input.body;
  if (channel === "sms" && contactId && !body.includes(STOP_FOOTER)) {
    if (await isFirstSmsToContact(context, contactId)) {
      body = `${body}\n${STOP_FOOTER}`;
    }
  }

  let providerRef: string | null = null;
  try {
    if (channel === "sms") {
      const from = input.smsFrom === "platform" ? null : await resolveCompanySmsFrom(context, companyId);
      providerRef = (await sendSms(from ? { to: input.to, body, from } : { to: input.to, body })).sid;
    } else {
      providerRef = (
        await sendEmail({
          to: input.to,
          subject: input.subject ?? "",
          body,
          html: input.html ?? undefined,
          fromName: input.fromName ?? undefined,
          replyTo: input.replyTo ?? undefined,
        })
      ).id;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeMessageLog(context, { ...base, body, status: "failed", error: reason });
    return { status: "failed", reason, body };
  }

  await writeMessageLog(context, { ...base, body, status: "sent", provider_ref: providerRef });

  // Meter it (Task 6). Best-effort.
  await recordUsageSafe({
    organizationId: context.organizationId,
    companyId,
    kind: channel === "sms" ? "sms_sent" : "email_sent",
    quantity: 1,
    unit: "message",
    provider: providerFor(channel),
    providerRef,
    metadata: { workflowRunId: input.workflowRunId ?? null },
  });

  // Timeline event for a customer message — emit-only so it can't re-trigger workflows.
  if (contactId) {
    try {
      await emitActivityEventAndDispatch(
        context,
        {
          companyId,
          entityType: "contact",
          entityId: contactId,
          eventType: channel === "sms" ? "contact.sms_sent" : "contact.email_sent",
          metadata: { to: input.to, providerRef, workflowRunId: input.workflowRunId ?? null },
        },
        { emitOnly: true },
      );
    } catch (err) {
      console.error("[messaging] activity event failed:", err instanceof Error ? err.message : err);
    }
  }

  return { status: "sent", providerRef, body };
}
