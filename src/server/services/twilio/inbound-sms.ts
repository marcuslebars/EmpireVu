// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4 (voice/messaging by-number routing): the inbound-SMS handler
// uses the Supabase service-role (RLS-bypassing) client — Twilio has no user session, so
// there is no RLS identity to act under. The TENANT IS ALWAYS RESOLVED SERVER-SIDE by the
// number the message came in ON (voice_numbers, provider='twilio'); nothing in the webhook
// payload can choose an organization or company. Runs only inside the inbound-webhook
// worker. No other route may import createSupabaseAdminClient.
// ─────────────────────────────────────────────────────────────────────────────
import type { Tables } from "@/server/db/database.types";
import { createActivityEvent } from "@/server/services/activity-events";
import { createContact } from "@/server/services/contacts";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import type { TenantServiceContext } from "@/server/services/shared";
import { recordUsageSafe } from "@/server/services/usage";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Service-role client for the inbound-SMS route/worker (sanctioned — see header). */
export function createTwilioAdminClient(): AdminClient {
  return createSupabaseAdminClient();
}

export interface InboundSmsFields {
  from: string | null;
  to: string | null;
  body: string;
  messageSid: string | null;
}

function readField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Twilio inbound-SMS form params → the fields we act on. */
export function readInboundSmsFields(payload: unknown): InboundSmsFields {
  return {
    from: readField(payload, "From"),
    to: readField(payload, "To"),
    body: readField(payload, "Body") ?? "",
    messageSid: readField(payload, "MessageSid") ?? readField(payload, "SmsSid"),
  };
}

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

/** Carrier/CTIA opt-out & opt-in keywords. Matches only when the whole message is the word. */
export function classifySmsKeyword(body: string): "stop" | "start" | null {
  const word = body.trim().toUpperCase();
  if (STOP_KEYWORDS.has(word)) return "stop";
  if (START_KEYWORDS.has(word)) return "start";
  return null;
}

interface VoiceNumberTenant {
  organization_id: string;
  company_id: string;
}

async function resolveSmsTenant(admin: AdminClient, toNumber: string): Promise<VoiceNumberTenant | null> {
  const { data } = await admin
    .from("voice_numbers")
    .select("organization_id, company_id")
    .eq("phone_e164", toNumber.trim())
    .eq("provider", "twilio")
    .eq("active", true)
    .maybeSingle();
  return (data as VoiceNumberTenant | null) ?? null;
}

async function findOrCreateContact(
  admin: AdminClient,
  context: TenantServiceContext,
  companyId: string,
  fromNumber: string,
): Promise<Tables<"contacts">> {
  const last10 = normalizePhoneLast10(fromNumber);
  if (last10) {
    const { data } = await admin
      .from("contacts")
      .select("*")
      .eq("organization_id", context.organizationId)
      .eq("company_id", companyId)
      .eq("phone_last10", last10)
      .limit(1)
      .maybeSingle();
    const existing = data as Tables<"contacts"> | null;
    if (existing) return existing;
  }

  // No match → a customer texting us first is a new lead. A customer-initiated message is
  // consent to reply (consent_source='inbound_sms'). contact.created is NOT dispatched —
  // contact.sms_received is the trigger we want, and firing both would double-notify.
  return createContact(
    context,
    {
      companyId,
      firstName: fromNumber,
      phone: fromNumber,
      consentSource: "inbound_sms",
      smsConsentAt: new Date().toISOString(),
    },
    { dispatchWorkflow: false },
  );
}

/**
 * Process one inbound SMS (worker handler for inbound_webhook_jobs provider='twilio').
 * Idempotent: a message we've already logged (by MessageSid) is a no-op, so a job retry
 * can't double-emit or double-count.
 */
export async function handleInboundSms(payload: unknown): Promise<void> {
  const fields = readInboundSmsFields(payload);
  if (!fields.messageSid || !fields.to || !fields.from) {
    throw new Error("Inbound SMS payload missing MessageSid, To, or From.");
  }

  const admin = createSupabaseAdminClient();

  // Idempotency: MessageSid is globally unique from Twilio.
  const { data: seen } = await admin
    .from("message_log")
    .select("id")
    .eq("provider", "twilio")
    .eq("provider_ref", fields.messageSid)
    .limit(1);
  if ((seen ?? []).length > 0) return;

  const tenant = await resolveSmsTenant(admin, fields.to);
  if (!tenant) {
    // A misconfigured number is not transient — surface it as a failed job for ops.
    throw new Error(`No active twilio voice_numbers row for ${fields.to}. Add one to route inbound SMS.`);
  }

  const context: TenantServiceContext = {
    organizationId: tenant.organization_id,
    actorProfileId: null,
    supabase: admin,
  };

  const contact = await findOrCreateContact(admin, context, tenant.company_id, fields.from);

  // Durable inbound record (audit). Throw on failure so the job retries.
  const { error: logError } = await admin.from("message_log").insert({
    organization_id: tenant.organization_id,
    company_id: tenant.company_id,
    contact_id: contact.id,
    channel: "sms",
    direction: "inbound",
    from_addr: fields.from,
    to_addr: fields.to,
    provider: "twilio",
    provider_ref: fields.messageSid,
    status: "received",
    body: fields.body,
  });
  if (logError) throw logError;

  await recordUsageSafe({
    organizationId: tenant.organization_id,
    companyId: tenant.company_id,
    kind: "sms_received",
    quantity: 1,
    unit: "message",
    provider: "twilio",
    providerRef: fields.messageSid,
  });

  const keyword = classifySmsKeyword(fields.body);

  if (keyword === "stop") {
    await admin
      .from("contacts")
      .update({ sms_opt_out_at: new Date().toISOString() })
      .eq("organization_id", tenant.organization_id)
      .eq("id", contact.id);
    // Timeline only — never dispatch a workflow off an opt-out (no auto-reply beyond
    // Twilio's own carrier confirmation).
    await createActivityEvent(context, {
      companyId: tenant.company_id,
      entityType: "contact",
      entityId: contact.id,
      eventType: "contact.sms_opted_out",
      metadata: { from: fields.from, providerRef: fields.messageSid },
    });
    return;
  }

  if (keyword === "start") {
    await admin
      .from("contacts")
      .update({ sms_opt_out_at: null, sms_consent_at: new Date().toISOString() })
      .eq("organization_id", tenant.organization_id)
      .eq("id", contact.id);
    await createActivityEvent(context, {
      companyId: tenant.company_id,
      entityType: "contact",
      entityId: contact.id,
      eventType: "contact.sms_opted_in",
      metadata: { from: fields.from, providerRef: fields.messageSid },
    });
    return;
  }

  // A normal reply → the workflow trigger. Any auto-reply a workflow sends is still
  // consent-checked downstream (deliverMessage), so an opted-out sender can't be texted.
  await emitActivityEventAndDispatch(context, {
    companyId: tenant.company_id,
    entityType: "contact",
    entityId: contact.id,
    eventType: "contact.sms_received",
    metadata: {
      from: fields.from,
      to: fields.to,
      providerRef: fields.messageSid,
      bodyPreview: fields.body.slice(0, 200),
    },
  });
}
