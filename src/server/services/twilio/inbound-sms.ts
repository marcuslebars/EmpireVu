// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4 (voice/messaging by-number routing): the inbound-SMS handler
// uses the Supabase service-role (RLS-bypassing) client — Twilio has no user session, so
// there is no RLS identity to act under. The TENANT IS ALWAYS RESOLVED SERVER-SIDE by the
// number the message came in ON (voice_numbers, provider='twilio'), or — on the platform
// number (TWILIO_FROM_NUMBER) — by the SENDER matching a company's owner phone; nothing in
// the webhook payload can choose an organization or company. Runs only inside the
// inbound-webhook worker. No other route may import createSupabaseAdminClient.
//
// Routing (docs/front-desk-ai.md "## Owner by text"):
//   platform number → STOP / START / HELP for platform texts; an owner → owner channel;
//                     anyone else → logged + one short "this number is for owners" reply
//   company number  → its owner → owner channel (no contact, no customer relay);
//                     a customer → message_log (+ MMS) → STOP / START / HELP → contact.sms_received
//                     → the SMS agent (never fails the job)
// ─────────────────────────────────────────────────────────────────────────────
import type { Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { createActivityEvent } from "@/server/services/activity-events";
import { createContact } from "@/server/services/contacts";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import type { TenantServiceContext } from "@/server/services/shared";
import { recordUsageSafe } from "@/server/services/usage";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { deliverMessage, STOP_FOOTER } from "@/server/services/workflow-engine/messaging";
import { sendSms } from "@/server/outbound/sms";
import type { InboundMedia } from "@/server/services/front-desk/contracts";
import {
  consumeLimit,
  findOwnerCompanies,
  isPlatformNumber,
  isPlatformOptedOut,
  samePhone,
  sendOwnerSms,
  setPlatformOptOut,
} from "@/server/services/owner-channel/common";
import { handleOwnerInboundSms } from "@/server/services/owner-channel/entry";
import { runSmsAgentForInbound } from "@/server/services/sms-agent/entry";
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
  media: InboundMedia[];
}

function readField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const MAX_MEDIA = 10;

/** MMS: NumMedia + MediaUrlN / MediaContentTypeN (Twilio caps a message at 10). */
export function readInboundMedia(payload: unknown): InboundMedia[] {
  const count = Math.min(MAX_MEDIA, Math.max(0, Number.parseInt(readField(payload, "NumMedia") ?? "0", 10) || 0));
  const media: InboundMedia[] = [];
  for (let i = 0; i < count; i++) {
    const url = readField(payload, `MediaUrl${i}`);
    if (url && /^https:\/\//i.test(url)) media.push({ url, contentType: readField(payload, `MediaContentType${i}`) });
  }
  return media;
}

/** Twilio inbound-SMS form params → the fields we act on. */
export function readInboundSmsFields(payload: unknown): InboundSmsFields {
  return {
    from: readField(payload, "From"),
    to: readField(payload, "To"),
    body: readField(payload, "Body") ?? "",
    messageSid: readField(payload, "MessageSid") ?? readField(payload, "SmsSid"),
    media: readInboundMedia(payload),
  };
}

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
/** CTIA re-opt-in keywords: always an opt-in. */
const START_KEYWORDS = new Set(["START", "UNSTOP"]);
/** "Yes" is an opt-in ONLY while the sender is opted out — otherwise it's an answer ("Y" to a question). */
const YES_KEYWORDS = new Set(["YES", "Y"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

export type SmsKeyword = "stop" | "start" | "yes" | "help";

/** Carrier/CTIA keywords. Matches only when the whole message is the word. */
export function classifySmsKeyword(body: string): SmsKeyword | null {
  const word = body.trim().replace(/[.!]+$/, "").toUpperCase();
  if (STOP_KEYWORDS.has(word)) return "stop";
  if (START_KEYWORDS.has(word)) return "start";
  if (YES_KEYWORDS.has(word)) return "yes";
  if (HELP_KEYWORDS.has(word)) return "help";
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

// ── Platform number ───────────────────────────────────────────────────────────

const PLATFORM_HELP_OWNER =
  "This is your front desk line. Reply Y/N to approvals, or text things like \"what's on tomorrow\" or \"who's waiting on me\". Reply STOP to opt out.";
const PLATFORM_UNKNOWN_SENDER =
  "CrankLeads: this number is for CrankLeads account owners. To reach a business, please text or call them directly. Reply STOP to opt out.";
const UNKNOWN_REPLY_WINDOW_S = 30 * 86_400;

type CommandLogIntent = "stop" | "start" | "help" | "unknown_sender" | "owner_company_keyword";

/** Log a platform-number text we handle here (not an owner command). False = already logged. */
async function logPlatformText(
  admin: AdminClient,
  fields: InboundSmsFields & { from: string; to: string; messageSid: string },
  intent: CommandLogIntent,
  extra: { organizationId?: string | null; companyId?: string | null; result?: Record<string, unknown> } = {},
): Promise<boolean> {
  const { error } = await admin.from("owner_command_log").insert({
    from_phone: fields.from,
    to_phone: fields.to,
    provider_ref: fields.messageSid,
    body: fields.body,
    intent,
    organization_id: extra.organizationId ?? null,
    company_id: extra.companyId ?? null,
    result: toJson(extra.result ?? {}),
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
  return true;
}

async function handlePlatformInbound(admin: AdminClient, fields: InboundSmsFields & { from: string; to: string; messageSid: string }): Promise<void> {
  // Idempotency: every platform-number text is logged once by MessageSid.
  const { data: seen } = await admin.from("owner_command_log").select("id").eq("provider_ref", fields.messageSid).limit(1);
  if ((seen ?? []).length > 0) return;

  const keyword = classifySmsKeyword(fields.body);
  if (keyword === "stop") {
    if (await logPlatformText(admin, fields, "stop")) await setPlatformOptOut(admin, fields.from, true, fields.messageSid);
    return; // Twilio sends the carrier confirmation.
  }
  if (keyword === "start" || (keyword === "yes" && (await isPlatformOptedOut(admin, fields.from)))) {
    if (await logPlatformText(admin, fields, "start")) await setPlatformOptOut(admin, fields.from, false, fields.messageSid);
    return;
  }

  const owned = await findOwnerCompanies(admin, fields.from);
  const last10 = normalizePhoneLast10(fields.from) ?? fields.from;

  if (keyword === "help") {
    const first = owned[0] ?? null;
    if (!(await logPlatformText(admin, fields, "help", { organizationId: first?.organizationId, companyId: first?.companyId }))) return;
    if (!(await consumeLimit(admin, `platform_help:${last10}`, 3, 86_400))) return;
    if (first) {
      await sendOwnerSms(admin, { to: fields.from, body: PLATFORM_HELP_OWNER, organizationId: first.organizationId, companyId: first.companyId, platformBrand: first.platformBrand });
    } else {
      await sendPlatformTextNoTenant(admin, fields.from, PLATFORM_UNKNOWN_SENDER);
    }
    return;
  }

  if (owned.length === 0) {
    // Not an owner. Log it; reply at most once a month (never to an opted-out phone).
    if (!(await logPlatformText(admin, fields, "unknown_sender"))) return;
    if (await consumeLimit(admin, `platform_unknown:${last10}`, 1, UNKNOWN_REPLY_WINDOW_S)) {
      await sendPlatformTextNoTenant(admin, fields.from, PLATFORM_UNKNOWN_SENDER);
    }
    return;
  }

  await handleOwnerInboundSms(admin, {
    from: fields.from,
    to: fields.to,
    body: fields.body,
    media: fields.media,
    providerRef: fields.messageSid,
    viaPlatformNumber: true,
    companyId: null,
  });
}

/** A platform text to someone who belongs to no tenant (no message_log row — it needs an org). */
async function sendPlatformTextNoTenant(admin: AdminClient, to: string, body: string): Promise<void> {
  try {
    if (await isPlatformOptedOut(admin, to)) return;
    await sendSms({ to, body });
  } catch (err) {
    console.error("[inbound-sms] platform reply failed:", err instanceof Error ? err.message : err);
  }
}

// ── Customer HELP ─────────────────────────────────────────────────────────────

async function replyToHelp(
  admin: AdminClient,
  context: TenantServiceContext,
  company: { id: string; name: string; brand_from_name: string | null },
  contact: Tables<"contacts">,
): Promise<void> {
  if (!contact.phone) return;
  if (!(await consumeLimit(admin, `sms_help:${company.id}:${contact.id}`, 1, 86_400))) return;
  const name = company.brand_from_name?.trim() || company.name;
  try {
    // HELP must be answered even for an opted-out sender (CTIA), so no consent gate here.
    await deliverMessage({
      context,
      channel: "sms",
      to: contact.phone,
      body: `${name}: text us here and we'll get back to you. ${STOP_FOOTER}.`,
      companyId: company.id,
      contactId: contact.id,
      consentContact: null,
    });
  } catch (err) {
    console.error("[inbound-sms] HELP reply failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Process one inbound SMS (worker handler for inbound_webhook_jobs provider='twilio').
 * Idempotent: a message we've already logged (by MessageSid — message_log for customer texts,
 * owner_command_log for owner/platform texts) is a no-op, so a job retry can't double-emit,
 * double-count or double-reply.
 */
export async function handleInboundSms(payload: unknown): Promise<void> {
  const parsed = readInboundSmsFields(payload);
  if (!parsed.messageSid || !parsed.to || !parsed.from) {
    throw new Error("Inbound SMS payload missing MessageSid, To, or From.");
  }
  const fields = { ...parsed, messageSid: parsed.messageSid, to: parsed.to, from: parsed.from };

  const admin = createSupabaseAdminClient();

  // Texts to the platform number (TWILIO_FROM_NUMBER) have no voice_numbers row.
  if (isPlatformNumber(fields.to)) {
    await handlePlatformInbound(admin, fields);
    return;
  }

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

  const { data: companyData } = await admin
    .from("companies")
    .select("id, name, brand_from_name, owner_phone_e164")
    .eq("organization_id", tenant.organization_id)
    .eq("id", tenant.company_id)
    .maybeSingle();
  const company = (companyData as { id: string; name: string; brand_from_name: string | null; owner_phone_e164: string | null } | null) ?? {
    id: tenant.company_id,
    name: "",
    brand_from_name: null,
    owner_phone_e164: null,
  };

  const keyword = classifySmsKeyword(fields.body);

  // The owner texting their own business number: owner channel, never a customer contact
  // (and never relayed back to them by customer-text-to-owner).
  if (samePhone(company.owner_phone_e164, fields.from)) {
    if (keyword === "stop" || keyword === "start") {
      // Carrier keywords to their own number: Twilio enforces them; just keep a record.
      await logPlatformText(admin, fields, "owner_company_keyword", { organizationId: tenant.organization_id, companyId: tenant.company_id });
      return;
    }
    const owner = await handleOwnerInboundSms(admin, {
      from: fields.from,
      to: fields.to,
      body: fields.body,
      media: fields.media,
      providerRef: fields.messageSid,
      viaPlatformNumber: false,
      companyId: tenant.company_id,
    });
    if (owner.handled) return;
  }

  const contact = await findOrCreateContact(admin, context, tenant.company_id, fields.from);

  // Durable inbound record (audit). Throw on failure so the job retries.
  const { data: logged, error: logError } = await admin
    .from("message_log")
    .insert({
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
      media: fields.media.length > 0 ? toJson(fields.media) : null,
    })
    .select("id")
    .single();
  if (logError) throw logError;
  const messageLogId = (logged as { id: string } | null)?.id ?? null;

  await recordUsageSafe({
    organizationId: tenant.organization_id,
    companyId: tenant.company_id,
    kind: "sms_received",
    quantity: 1,
    unit: "message",
    provider: "twilio",
    providerRef: fields.messageSid,
  });

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

  // START/UNSTOP always re-opt-in; "Yes"/"Y" only when they're currently opted out
  // (otherwise it's an answer to a question and goes to the conversation).
  if (keyword === "start" || (keyword === "yes" && contact.sms_opt_out_at)) {
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

  if (keyword === "help") {
    await replyToHelp(admin, context, company, contact);
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
      ...(fields.media.length > 0 ? { mediaCount: fields.media.length } : {}),
    },
  });

  // The AI front desk. Never fails the job: the text is stored and the owner can see it.
  try {
    await runSmsAgentForInbound(admin, {
      organizationId: tenant.organization_id,
      companyId: tenant.company_id,
      contactId: contact.id,
      messageLogId,
      from: fields.from,
      to: fields.to,
      body: fields.body,
      media: fields.media,
      receivedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[inbound-sms] SMS agent failed:", err instanceof Error ? err.message : err);
  }
}
