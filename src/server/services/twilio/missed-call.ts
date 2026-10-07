// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4b (voice/messaging by-number routing — missed-call catcher):
// the Twilio voice webhook route and the inbound-webhook worker handlers below use the
// Supabase service-role (RLS-bypassing) client — Twilio has no user session, so there is
// no RLS identity to act under. The TENANT IS ALWAYS RESOLVED SERVER-SIDE from the number
// the call came in ON (`To`, a voice_numbers row with provider='twilio' and
// mode='missed_call_catcher'); the request is HMAC-verified (X-Twilio-Signature) before
// anything is read, and nothing in the payload can choose an organization or company.
// Voicemail callbacks are tied to their tenant through the missed_calls row created for
// the same CallSid. Listed in docs/EMPIREVU_RUNBOOK.md → "Service-role (sanctioned) surfaces".
// ─────────────────────────────────────────────────────────────────────────────
import type { Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { createActivityEvent, type CreateActivityEventInput } from "@/server/services/activity-events";
import { LEAD_SCHEMA_VERSION } from "@/server/services/lead-intake/envelope";
import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import { toE164 } from "@/server/services/retell/payload";
import type { TenantServiceContext } from "@/server/services/shared";
import {
  FORWARDING_TEST_LEG_KEY,
  isTestCallerId,
  recordFlaggedForwardedLeg,
  recordPassiveForwardingProof,
} from "@/server/services/twilio/forwarding-test";
import { textBackWindowMinutes, transcriptionEnabled } from "@/server/services/twilio/voice-config";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { deliverMessage, resolveOwnerContacts } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { appBaseUrlFor, loadOrganizationBrand, platformBrand, type PlatformBrand } from "@/server/services/platform-brand";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type MissedCallRow = Tables<"missed_calls">;

export const CATCHER_MODE = "missed_call_catcher";
export const MISSED_CALL_SOURCE = "missed_call_catcher";
/** inbound_webhook_jobs providers (routes enqueue, the worker dispatches). */
export const VOICE_JOB_PROVIDER = "twilio_voice";
export const VOICEMAIL_JOB_PROVIDER = "twilio_voicemail";
/** Recordings shorter than this are hang-ups / silence, not voicemails worth an alert. */
const MIN_VOICEMAIL_SECONDS = 2;

/** Service-role client for the voice routes/worker (sanctioned — see header). */
export function createMissedCallAdminClient(): AdminClient {
  return createSupabaseAdminClient();
}

function readField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// ── Payload readers ───────────────────────────────────────────────────────────

export interface InboundVoiceFields {
  callSid: string | null;
  /** The ORIGINAL caller — Twilio keeps `From` as the caller on a forwarded call. */
  from: string | null;
  /** The catcher number that was reached. */
  to: string | null;
  /** The business line that forwarded the call, when the carrier passes it. */
  forwardedFrom: string | null;
  callerName: string | null;
  callStatus: string | null;
}

export function readInboundVoiceFields(payload: unknown): InboundVoiceFields {
  return {
    callSid: readField(payload, "CallSid"),
    from: readField(payload, "From"),
    to: readField(payload, "To") ?? readField(payload, "Called"),
    forwardedFrom: readField(payload, "ForwardedFrom"),
    callerName: readField(payload, "CallerName"),
    callStatus: readField(payload, "CallStatus"),
  };
}

export interface VoicemailFields {
  callSid: string | null;
  recordingSid: string | null;
  recordingUrl: string | null;
  recordingStatus: string | null;
  recordingDurationSeconds: number | null;
  transcriptionSid: string | null;
  transcriptionStatus: string | null;
  transcriptionText: string | null;
}

export function readVoicemailFields(payload: unknown): VoicemailFields {
  const duration = Number.parseInt(readField(payload, "RecordingDuration") ?? "", 10);
  return {
    callSid: readField(payload, "CallSid"),
    recordingSid: readField(payload, "RecordingSid"),
    recordingUrl: readField(payload, "RecordingUrl"),
    recordingStatus: readField(payload, "RecordingStatus"),
    recordingDurationSeconds: Number.isFinite(duration) ? duration : null,
    transcriptionSid: readField(payload, "TranscriptionSid"),
    transcriptionStatus: readField(payload, "TranscriptionStatus"),
    transcriptionText: readField(payload, "TranscriptionText"),
  };
}

/** The durable-queue key for a voicemail callback. The <Record> action and the
 *  recording-status callback share a RecordingSid, so whichever lands first wins and the
 *  other is a no-op; a transcription has its own sid. */
export function voicemailExternalId(payload: Record<string, string>): string | null {
  if (payload.TranscriptionSid) return `transcription:${payload.TranscriptionSid}`;
  if (payload.RecordingSid) return `recording:${payload.RecordingSid}`;
  return null;
}

/** Twilio/carrier placeholders for a withheld caller id — we can't text those back. */
const ANONYMOUS_IDS = new Set(["anonymous", "restricted", "unknown", "private", "unavailable", "blocked"]);
const ANONYMOUS_NUMBERS = new Set(["+266696687", "+7378742833", "+2562533", "+8656696", "+86282452253"]);

export function isAnonymousCaller(from: string | null): boolean {
  if (!from) return true;
  if (ANONYMOUS_IDS.has(from.trim().toLowerCase())) return true;
  if (ANONYMOUS_NUMBERS.has(from.trim())) return true;
  return normalizePhoneLast10(from) === null;
}

// ── Tenant resolution ─────────────────────────────────────────────────────────

export interface CatcherTenant {
  organizationId: string;
  companyId: string;
  companyName: string | null;
  companySlug: string | null;
  phoneE164: string;
}

/**
 * Resolve the tenant from the number that was CALLED. Returns null when no active catcher
 * number matches (unknown/misconfigured number); throws on a DB error so the caller can
 * tell "not ours" from "couldn't check".
 */
export async function resolveCatcherTenant(admin: AdminClient, calledNumber: string | null): Promise<CatcherTenant | null> {
  const phone = toE164(calledNumber);
  if (!phone) return null;
  const { data, error } = await admin
    .from("voice_numbers")
    .select("organization_id, company_id, phone_e164, brand_label")
    .eq("phone_e164", phone)
    .eq("provider", "twilio")
    .eq("mode", CATCHER_MODE)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  const row = data as Pick<Tables<"voice_numbers">, "organization_id" | "company_id" | "phone_e164" | "brand_label"> | null;
  if (!row) return null;

  const { data: company, error: companyError } = await admin
    .from("companies")
    .select("name, slug")
    .eq("organization_id", row.organization_id)
    .eq("id", row.company_id)
    .maybeSingle();
  if (companyError) throw companyError;
  const companyRow = company as Pick<Tables<"companies">, "name" | "slug"> | null;

  return {
    organizationId: row.organization_id,
    companyId: row.company_id,
    companyName: companyRow?.name ?? row.brand_label ?? null,
    companySlug: companyRow?.slug ?? null,
    phoneE164: row.phone_e164,
  };
}

export interface VoiceNumberOwner {
  organization_id: string;
  company_id: string;
  provider: string;
  mode: string;
  active: boolean;
}

/**
 * Who owns this number, across ALL orgs (service role — an RLS client only sees its own
 * org, which is exactly what a takeover attempt would exploit). Used by catcher
 * provisioning to refuse numbers already connected elsewhere, active or not. Returns only
 * ownership columns.
 */
export async function findVoiceNumberOwner(admin: AdminClient, phoneE164: string): Promise<VoiceNumberOwner | null> {
  const { data, error } = await admin
    .from("voice_numbers")
    .select("organization_id, company_id, provider, mode, active")
    .eq("phone_e164", phoneE164)
    .maybeSingle();
  if (error) throw error;
  return (data as VoiceNumberOwner | null) ?? null;
}

// ── Lead envelope ─────────────────────────────────────────────────────────────

/** A missed call → the canonical phone-lead envelope, so it flows through the SAME intake
 *  path as a form / Retell call (durable raw_leads row, contact match-or-create by phone
 *  with implied inquiry consent, lead notification). Pure + tested. */
export function buildMissedCallLeadEnvelope(
  fields: InboundVoiceFields,
  tenant: Pick<CatcherTenant, "companySlug">,
  receivedAt: string = new Date().toISOString(),
): Record<string, unknown> {
  const phone = toE164(fields.from) ?? fields.from ?? undefined;
  const forwarded = toE164(fields.forwardedFrom) ?? fields.forwardedFrom;
  const message = [
    `Missed call from ${phone ?? "unknown caller"}${forwarded ? ` (forwarded from ${forwarded})` : ""}.`,
    "Caught by the missed-call catcher — an automatic text-back goes out if the missed-call text-back automation is on.",
  ].join(" ");
  return {
    schemaVersion: LEAD_SCHEMA_VERSION,
    source: MISSED_CALL_SOURCE,
    sourceSite: tenant.companySlug ?? "missed-call",
    formType: "phone-lead",
    receivedAt,
    contact: { phone },
    message,
    meta: { site: "missed-call-catcher" },
  };
}

// ── Worker: the call ──────────────────────────────────────────────────────────

async function loadMissedCall(admin: AdminClient, callSid: string): Promise<MissedCallRow | null> {
  const { data, error } = await admin.from("missed_calls").select("*").eq("call_sid", callSid).maybeSingle();
  if (error) throw error;
  return (data as MissedCallRow | null) ?? null;
}

async function updateMissedCall(admin: AdminClient, id: string, patch: Partial<MissedCallRow>): Promise<void> {
  const { error } = await admin.from("missed_calls").update(patch).eq("id", id);
  if (error) throw error;
}

/** Was call.missed already emitted for this call? (A job retry after a partial run.) */
async function callMissedAlreadyEmitted(admin: AdminClient, organizationId: string, callSid: string): Promise<boolean> {
  const { data, error } = await admin
    .from("activity_events")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("event_type", "call.missed")
    .eq("metadata_json->>callId", callSid)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** The most recent text-back to this caller inside the throttle window, if any. */
async function recentTextBack(
  admin: AdminClient,
  row: MissedCallRow,
  windowMinutes: number,
  now: number,
): Promise<Pick<MissedCallRow, "id" | "contact_id" | "lead_id"> | null> {
  if (windowMinutes <= 0 || !row.caller_phone_last10) return null;
  const since = new Date(now - windowMinutes * 60_000).toISOString();
  const { data, error } = await admin
    .from("missed_calls")
    .select("id, contact_id, lead_id")
    .eq("organization_id", row.organization_id)
    .eq("company_id", row.company_id)
    .eq("caller_phone_last10", row.caller_phone_last10)
    .eq("text_back_status", "emitted")
    .neq("call_sid", row.call_sid)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as Array<Pick<MissedCallRow, "id" | "contact_id" | "lead_id">>;
  return rows[0] ?? null;
}

/**
 * Will a call.missed actually text the caller? True when the company (or an org-wide)
 * workflow on call.missed is ACTIVE and has a send_sms to the contact. Drives the push copy
 * so it never claims "texting them back" when the automation is off/draft. Best-effort.
 */
export async function textBackAutomationActive(admin: AdminClient, organizationId: string, companyId: string): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("workflows")
      .select("company_id, definition")
      .eq("organization_id", organizationId)
      .eq("trigger_event", "call.missed")
      .eq("status", "active")
      .limit(50);
    if (error) throw error;
    const rows = (data ?? []) as Array<Pick<Tables<"workflows">, "company_id" | "definition">>;
    return rows.some((row) => {
      if (row.company_id !== null && row.company_id !== companyId) return false;
      const definition = row.definition;
      const actions =
        definition && typeof definition === "object" && !Array.isArray(definition) ? definition.actions : null;
      return (
        Array.isArray(actions) &&
        actions.some((action) => {
          if (!action || typeof action !== "object" || Array.isArray(action)) return false;
          return action.type === "send_sms" && action.to !== "owner";
        })
      );
    });
  } catch (err) {
    console.error("[missed-call] could not read text-back automation state:", err instanceof Error ? err.message : err);
    return false;
  }
}

export interface HandleMissedCallResult {
  /** forwarding_test: the voice webhook flagged this call as the forwarded leg of a
   *  forwarding test (test marked passed; no lead, no text-back). test_caller: a call from
   *  our own test caller ID that wasn't flagged (never a customer — dropped). */
  status: "emitted" | "suppressed" | "anonymous" | "duplicate" | "forwarding_test" | "test_caller";
  contactId: string | null;
  leadId: string | null;
}

/**
 * Process one caught call (worker handler for inbound_webhook_jobs provider='twilio_voice').
 *
 *   1) resolve the tenant from `To` (unknown number → throw: the raw job stays, dead-letters
 *      after retries, and shows in ops — a misconfigured number is not transient);
 *   2) insert-or-load the per-call missed_calls row (unique CallSid);
 *   3) withheld caller id → timeline + push only (nothing to text);
 *   4) repeat caller inside MISSED_CALL_TEXTBACK_WINDOW_MINUTES → reuse their contact, no
 *      second lead, call.missed recorded emit-only (no second text-back);
 *   5) otherwise run the SAME lead intake as a form/Retell call (contact match by phone),
 *      then emit `call.missed` through emitActivityEventAndDispatch → workflow_event_jobs,
 *      so the missed-call-text-back recipe fires unchanged.
 * Idempotent: exactly one call.missed per CallSid, one lead per call.
 */
export async function handleMissedCall(payload: unknown, now: number = Date.now()): Promise<HandleMissedCallResult> {
  const fields = readInboundVoiceFields(payload);
  if (!fields.callSid || !fields.to) {
    throw new Error("Inbound voice payload missing CallSid or To.");
  }

  const admin = createSupabaseAdminClient();
  const tenant = await resolveCatcherTenant(admin, fields.to);
  if (!tenant) {
    throw new Error(
      `No active missed-call catcher number for ${fields.to}. Add a voice_numbers row (provider='twilio', mode='missed_call_catcher').`,
    );
  }

  // (1b) Forwarding verification (docs/missed-call-catcher.md → Forwarding verification):
  //      the voice webhook ALONE decides whether a call is the forwarded leg of our test call
  //      (From == the test's caller ID — a number we own — inside the window) and stamps the
  //      test id into this durable payload. Flagged → mark the test passed and stop (no
  //      missed_calls row, no lead, no text-back); a failure here retries the job (it is our
  //      own call — no customer is waiting). NO re-matching: a call without the flag is
  //      always a normal missed call, whatever its From / ForwardedFrom say.
  const flaggedTestId = readField(payload, FORWARDING_TEST_LEG_KEY);
  if (flaggedTestId) {
    const passed = await recordFlaggedForwardedLeg(
      admin,
      tenant,
      { testId: flaggedTestId, callSid: fields.callSid, forwardedFrom: fields.forwardedFrom },
      now,
    );
    if (passed) return { status: "forwarding_test", contactId: null, leadId: null };
  }
  if (isTestCallerId(fields.from, tenant.phoneE164)) {
    console.warn(`[missed-call] call ${fields.callSid} is from our own test caller ID outside any test — ignored.`);
    return { status: "test_caller", contactId: null, leadId: null };
  }
  // Passive proof: a real call the carrier forwarded from the business line shows forwarding
  // works (sets voice_numbers.forwarding_verified_at). Best-effort.
  await recordPassiveForwardingProof(admin, tenant, fields.forwardedFrom, now);

  const fromE164 = toE164(fields.from);
  const anonymous = isAnonymousCaller(fields.from);

  // (2) The per-call record. ON CONFLICT (call_sid) DO NOTHING, then load whichever row won.
  const { error: insertError } = await admin.from("missed_calls").upsert(
    {
      organization_id: tenant.organizationId,
      company_id: tenant.companyId,
      call_sid: fields.callSid,
      provider: "twilio",
      from_number: fromE164 ?? fields.from,
      to_number: tenant.phoneE164,
      forwarded_from: toE164(fields.forwardedFrom) ?? fields.forwardedFrom,
      caller_phone_last10: anonymous ? null : normalizePhoneLast10(fields.from),
      caller_name: fields.callerName,
      text_back_status: "pending",
      raw_payload: toJson(payload),
    },
    { onConflict: "call_sid", ignoreDuplicates: true },
  );
  if (insertError) throw insertError;
  const row = await loadMissedCall(admin, fields.callSid);
  if (!row) throw new Error(`missed_calls row for ${fields.callSid} not found after insert.`);
  if (row.text_back_status !== "pending") {
    return { status: "duplicate", contactId: row.contact_id, leadId: row.lead_id };
  }

  const context: TenantServiceContext = { organizationId: tenant.organizationId, actorProfileId: null, supabase: admin };
  const baseMetadata = {
    callId: fields.callSid,
    direction: "inbound",
    source: MISSED_CALL_SOURCE,
    provider: "twilio",
    fromNumber: fromE164 ?? fields.from,
    forwardedFrom: row.forwarded_from,
  };

  // (3) No caller id: nobody to text or match. Tell the owner, keep the record.
  if (anonymous) {
    if (!(await callMissedAlreadyEmitted(admin, tenant.organizationId, fields.callSid))) {
      await createActivityEvent(context, {
        companyId: tenant.companyId,
        entityType: "company",
        entityId: tenant.companyId,
        eventType: "call.missed",
        metadata: { ...baseMetadata, anonymous: true, name: "Private number" },
      });
    }
    await updateMissedCall(admin, row.id, { text_back_status: "anonymous" });
    return { status: "anonymous", contactId: null, leadId: null };
  }

  // (4) Throttle — same caller texted back within the window.
  const recent = await recentTextBack(admin, row, textBackWindowMinutes(), now);
  const suppressed = recent !== null;

  // (5) Lead + contact. Skipped when a previous attempt already linked them (job retry) or
  //     when a repeat caller's lead was captured minutes ago (link to that one instead).
  let contactId = row.contact_id;
  let leadId = row.lead_id;
  if (!contactId && !leadId) {
    if (recent?.contact_id) {
      contactId = recent.contact_id;
      leadId = recent.lead_id;
    } else {
      const envelope = buildMissedCallLeadEnvelope(fields, tenant, new Date(now).toISOString());
      const result = await handleLeadIntake(JSON.stringify(envelope), envelope, {
        target: { organizationId: tenant.organizationId, companyId: tenant.companyId },
      });
      leadId = result.leadId;
      try {
        const { data: rawLead } = await admin.from("raw_leads").select("contact_id").eq("lead_id", result.leadId).maybeSingle();
        contactId = (rawLead as { contact_id: string | null } | null)?.contact_id ?? null;
      } catch (err) {
        console.error("[missed-call] could not read the lead's contact:", err instanceof Error ? err.message : err);
      }
    }
    // Link now, so a retry never runs intake twice. The lead is already durable; a failed
    // link is logged, not fatal.
    try {
      await updateMissedCall(admin, row.id, { contact_id: contactId, lead_id: leadId });
    } catch (err) {
      console.error("[missed-call] failed to link call to lead:", err instanceof Error ? err.message : err);
    }
  }

  // (6) call.missed — the trigger the missed-call-text-back recipe listens on. Same path as
  //     the Retell adapter: activity event + workflow_event_jobs enqueue. Suppressed repeat
  //     calls are recorded on the timeline emit-only (no workflow → no second text).
  if (!(await callMissedAlreadyEmitted(admin, tenant.organizationId, fields.callSid))) {
    const input: CreateActivityEventInput = {
      companyId: tenant.companyId,
      entityType: contactId ? "contact" : "company",
      entityId: contactId ?? tenant.companyId,
      eventType: "call.missed",
      metadata: {
        ...baseMetadata,
        contactId,
        leadId,
        textBackSuppressed: suppressed,
        textBackActive: suppressed ? false : await textBackAutomationActive(admin, tenant.organizationId, tenant.companyId),
      },
    };
    await emitActivityEventAndDispatch(context, input, suppressed ? { emitOnly: true } : {});
  }
  await updateMissedCall(admin, row.id, { text_back_status: suppressed ? "suppressed" : "emitted" });

  return { status: suppressed ? "suppressed" : "emitted", contactId, leadId };
}

// ── Worker: the voicemail ─────────────────────────────────────────────────────

/** Twilio only transcribes recordings up to 2 minutes. */
const TRANSCRIBE_MAX_SECONDS = 120;
/** If a transcript is expected but never arrives, the owner alert goes out after this. */
export const ALERT_FALLBACK_DELAY_MS = 10 * 60_000;

function voicemailAnchor(row: MissedCallRow): Pick<CreateActivityEventInput, "entityType" | "entityId"> {
  return row.contact_id
    ? { entityType: "contact", entityId: row.contact_id }
    : { entityType: "company", entityId: row.company_id };
}

/** Twilio's RecordingUrl has no extension; `.mp3` serves a browser-playable file. */
export function playableRecordingUrl(recordingUrl: string | null): string | null {
  if (!recordingUrl) return null;
  return /\.(mp3|wav)$/i.test(recordingUrl) ? recordingUrl : `${recordingUrl}.mp3`;
}

/**
 * Where the owner should go: the contact's page in the app (Calls tab has the player). The
 * raw Twilio recording URL is a bearer link (anyone holding it can listen), so it is never
 * put in an email.
 */
export function appLinkForMissedCall(
  row: Pick<MissedCallRow, "contact_id">,
  brand: PlatformBrand = platformBrand(null),
): string | null {
  // EmpireVu keeps its old behaviour (no link when APP_BASE_URL is unset); CrankLeads has a default host.
  const base = brand.key === "empirevu" && !process.env.APP_BASE_URL?.trim() ? null : appBaseUrlFor(brand);
  if (!base) return null;
  return row.contact_id ? `${base}/crm/${row.contact_id}` : `${base}/`;
}

/** Plain-text owner email for a voicemail. Pure + tested. */
export function buildVoicemailOwnerAlert(args: {
  companyName: string | null;
  callerNumber: string | null;
  appUrl: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  textBackStatus: string;
  /** An SMS to the caller was actually sent (message_log), not just an event emitted. */
  textedBack: boolean;
  /** Product name the owner knows the app by (EmpireVu / CrankLeads). */
  productName?: string;
}): { subject: string; body: string } {
  const who = args.callerNumber ?? "a private number";
  const textLine =
    args.textBackStatus === "anonymous"
      ? "Their caller ID was withheld, so no text-back could be sent."
      : args.textedBack
        ? "We already texted them back automatically."
        : args.textBackStatus === "suppressed"
          ? "They called again within a few minutes — no second text was sent."
          : "No automatic text went out — reply to them yourself.";
  const lines = [
    `New voicemail from ${who}${args.companyName ? ` for ${args.companyName}` : ""}${args.durationSeconds ? ` (${args.durationSeconds}s)` : ""}.`,
    "",
    args.transcript ? `"${args.transcript}"` : `(No transcript — open the call in ${args.productName ?? platformBrand(null).name} to listen.)`,
    "",
    args.appUrl ? `Listen and call back: ${args.appUrl}` : null,
    textLine,
    "Call them back while it's hot.",
  ];
  return {
    subject: `Voicemail from ${who}${args.companyName ? ` — ${args.companyName}` : ""}`,
    body: lines.filter((line): line is string => line !== null).join("\n"),
  };
}

async function smsSentToCaller(admin: AdminClient, row: MissedCallRow): Promise<boolean> {
  if (!row.contact_id) return false;
  const { data, error } = await admin
    .from("message_log")
    .select("id")
    .eq("organization_id", row.organization_id)
    .eq("contact_id", row.contact_id)
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .eq("status", "sent")
    .gte("created_at", row.created_at)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

/** Atomically claim the one-time owner alert (owner_alerted_at IS NULL → now). */
async function claimOwnerAlert(admin: AdminClient, rowId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("missed_calls")
    .update({ owner_alerted_at: new Date().toISOString() })
    .eq("id", rowId)
    .is("owner_alerted_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Send the owner email exactly once per call (claim first; un-claim if sending throws). */
async function alertOwnerOfVoicemail(admin: AdminClient, rowId: string, callSid: string): Promise<void> {
  if (!(await claimOwnerAlert(admin, rowId))) return;
  try {
    const row = await loadMissedCall(admin, callSid);
    if (!row) return;
    const context: TenantServiceContext = { organizationId: row.organization_id, actorProfileId: null, supabase: admin };
    const { data: company } = await admin
      .from("companies")
      .select("name, owner_email, owner_phone_e164")
      .eq("organization_id", row.organization_id)
      .eq("id", row.company_id)
      .maybeSingle();
    const companyRow = company as Pick<Tables<"companies">, "name" | "owner_email" | "owner_phone_e164"> | null;
    const owner = await resolveOwnerContacts(context, companyRow);
    const brand = await loadOrganizationBrand(admin, row.organization_id);
    const alert = buildVoicemailOwnerAlert({
      productName: brand.name,
      companyName: companyRow?.name ?? null,
      callerNumber: row.from_number,
      appUrl: appLinkForMissedCall(row, brand),
      durationSeconds: row.recording_duration_seconds,
      transcript: row.transcription_text,
      textBackStatus: row.text_back_status,
      textedBack: await smsSentToCaller(admin, row),
    });
    await deliverMessage({
      context,
      channel: "email",
      to: owner.email,
      subject: alert.subject,
      body: alert.body,
      companyId: row.company_id,
      contactId: null,
      consentContact: null,
    });
  } catch (err) {
    // Release the claim so the fallback / a retry can send it.
    await admin.from("missed_calls").update({ owner_alerted_at: null }).eq("id", rowId);
    throw err;
  }
}

async function alertOwnerSafely(admin: AdminClient, rowId: string, callSid: string): Promise<void> {
  try {
    await alertOwnerOfVoicemail(admin, rowId, callSid);
  } catch (err) {
    console.error("[missed-call] owner voicemail alert failed:", err instanceof Error ? err.message : err);
  }
}

/** Queue a delayed "send the alert if it still hasn't gone" job (same durable queue). */
async function scheduleAlertFallback(admin: AdminClient, callSid: string, recordingSid: string): Promise<void> {
  const { error } = await admin.from("inbound_webhook_jobs").upsert(
    {
      provider: VOICEMAIL_JOB_PROVIDER,
      external_id: `alert:${recordingSid}`,
      payload: toJson({ CallSid: callSid, AlertFallback: "true" }),
      status: "pending",
      max_attempts: 5,
      run_at: new Date(Date.now() + ALERT_FALLBACK_DELAY_MS).toISOString(),
    },
    { onConflict: "provider,external_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

/**
 * Process a voicemail callback (worker handler for provider='twilio_voicemail'):
 *   • recording (<Record> action / status callback): store it, timeline + push, then the
 *     owner email — now, unless a transcript is coming (transcription on AND ≤ 120 s), in
 *     which case a delayed fallback job guarantees the email even if no transcript arrives;
 *   • transcription: needs the recording stored first (throws → retry), stores the text,
 *     sends the owner email with it;
 *   • AlertFallback: sends the email if it still hasn't gone.
 * The owner email is sent at most once (owner_alerted_at claim). The missed_calls row is the
 * tenant link — if the call job hasn't been processed yet, throw so the job retries.
 */
export async function handleVoicemail(payload: unknown): Promise<void> {
  const fields = readVoicemailFields(payload);
  if (!fields.callSid) throw new Error("Voicemail payload missing CallSid.");

  const admin = createSupabaseAdminClient();
  const row = await loadMissedCall(admin, fields.callSid);
  if (!row) {
    throw new Error(`No missed_calls row for ${fields.callSid} yet — will retry once the call is processed.`);
  }
  const context: TenantServiceContext = { organizationId: row.organization_id, actorProfileId: null, supabase: admin };
  const worthAlerting = (seconds: number | null) => (seconds ?? 0) >= MIN_VOICEMAIL_SECONDS;

  // Fallback: the transcript never came.
  if (readField(payload, "AlertFallback") === "true") {
    if (!row.owner_alerted_at && worthAlerting(row.recording_duration_seconds)) {
      await alertOwnerSafely(admin, row.id, row.call_sid);
    }
    return;
  }

  // Transcription callback.
  if (fields.transcriptionSid) {
    if (!row.recording_sid) {
      throw new Error(`Transcription for ${row.call_sid} arrived before its recording — will retry.`);
    }
    if (row.transcription_sid === fields.transcriptionSid) return;
    await updateMissedCall(admin, row.id, {
      transcription_sid: fields.transcriptionSid,
      transcription_status: fields.transcriptionStatus,
      transcription_text: fields.transcriptionText,
    });
    if (fields.transcriptionText) {
      try {
        await createActivityEvent(context, {
          companyId: row.company_id,
          ...voicemailAnchor(row),
          eventType: "call.voicemail_transcribed",
          metadata: { callId: row.call_sid, source: MISSED_CALL_SOURCE, transcript: fields.transcriptionText.slice(0, 2000) },
        });
      } catch (err) {
        console.error("[missed-call] transcript activity failed:", err instanceof Error ? err.message : err);
      }
    }
    if (worthAlerting(row.recording_duration_seconds)) {
      await alertOwnerSafely(admin, row.id, row.call_sid);
    }
    return;
  }

  // Recording (the <Record> action or the status callback — whichever arrives first).
  if (fields.recordingStatus && fields.recordingStatus !== "completed") return;
  if (!fields.recordingSid || row.recording_sid) return;

  const recordingUrl = playableRecordingUrl(fields.recordingUrl);
  await updateMissedCall(admin, row.id, {
    recording_sid: fields.recordingSid,
    recording_url: recordingUrl,
    recording_duration_seconds: fields.recordingDurationSeconds,
    voicemail_at: new Date().toISOString(),
  });
  if (!worthAlerting(fields.recordingDurationSeconds)) return;

  // Timeline + push (push fans out from the activity event). Best-effort.
  try {
    await createActivityEvent(context, {
      companyId: row.company_id,
      ...voicemailAnchor(row),
      eventType: "call.voicemail",
      metadata: {
        callId: row.call_sid,
        source: MISSED_CALL_SOURCE,
        fromNumber: row.from_number,
        recordingUrl,
        durationSeconds: fields.recordingDurationSeconds,
        contactId: row.contact_id,
      },
    });
  } catch (err) {
    console.error("[missed-call] voicemail activity failed:", err instanceof Error ? err.message : err);
  }

  const transcriptExpected =
    transcriptionEnabled() && (fields.recordingDurationSeconds ?? 0) <= TRANSCRIBE_MAX_SECONDS;
  if (transcriptExpected) {
    try {
      await scheduleAlertFallback(admin, row.call_sid, fields.recordingSid);
      return;
    } catch (err) {
      console.error("[missed-call] could not schedule the alert fallback; alerting now:", err instanceof Error ? err.message : err);
    }
  }
  await alertOwnerSafely(admin, row.id, row.call_sid);
}
