import type { Inserts, Tables } from "@/server/db/database.types";
import { sendEmail } from "@/server/outbound/email";
import { sendSms } from "@/server/outbound/sms";
import type { TenantServiceContext } from "@/server/services/shared";
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

export async function resolveOwnerContacts(
  context: TenantServiceContext,
  company: Pick<Tables<"companies">, "owner_email" | "owner_phone_e164"> | null,
): Promise<OwnerContacts> {
  let email = company?.owner_email?.trim() || null;
  const phone = company?.owner_phone_e164?.trim() || null;
  if (!email) email = process.env.OWNER_EMAIL?.trim() || null;
  if (!email) email = await orgOwnerEmail(context);
  return { email, phone };
}

async function orgOwnerEmail(context: TenantServiceContext): Promise<string | null> {
  const { data: membership } = await context.supabase
    .from("organization_memberships")
    .select("profile_id")
    .eq("organization_id", context.organizationId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  const profileId = (membership as { profile_id: string } | null)?.profile_id;
  if (!profileId) return null;
  const { data: profile } = await context.supabase
    .from("profiles")
    .select("email")
    .eq("id", profileId)
    .maybeSingle();
  return (profile as { email: string } | null)?.email ?? null;
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

// ── Deliver ───────────────────────────────────────────────────────────────────
export interface DeliverMessageInput {
  context: TenantServiceContext;
  channel: MessageChannel;
  /** Resolved recipient (phone for sms, email for email). Null → nothing to send. */
  to: string | null;
  body: string;
  companyId: string | null;
  /** The contact being messaged, or null for owner/literal recipients. */
  contactId: string | null;
  /** Consent is checked only when messaging a known contact. */
  consentContact: ConsentContact | null;
  subject?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  workflowRunId?: string | null;
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
  };

  if (!input.to) {
    await writeMessageLog(context, { ...base, body: input.body, status: "blocked", error: "no_recipient" });
    return { status: "blocked", reason: "no_recipient", body: input.body };
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
      providerRef = (await sendSms({ to: input.to, body })).sid;
    } else {
      providerRef = (
        await sendEmail({
          to: input.to,
          subject: input.subject ?? "",
          body,
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
