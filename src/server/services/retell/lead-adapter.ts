import { randomBytes } from "node:crypto";

import type { Json } from "@/server/db/database.types";
import { createActivityEvent } from "@/server/services/activity-events";
import { LEAD_SCHEMA_VERSION } from "@/server/services/lead-intake/envelope";
import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import type { TenantServiceContext } from "@/server/services/shared";
import { getRetellConfig } from "./config";
import {
  asRecord,
  coerceBoatLengthFt,
  coerceEngineCount,
  coerceEngineType,
  normalizePhoneLast10,
  readBoolean,
  readFirst,
  readPath,
  readString,
  readStringArray,
  toE164,
} from "./payload";
import {
  createRetellAdminClient,
  resolveRetellTenant,
  type RetellAdminClient,
  type RetellTenant,
} from "./tenant";

// retell_calls isn't in the generated database.types.ts (no gen-types step), same as
// the jobber_* tables — access it via the admin client cast to any, shaping rows with
// the interfaces in this module. Regenerating database.types.ts restores first-class
// typing (tracked in docs/retell-integration.md).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const retellCalls = (admin: RetellAdminClient): any => (admin as any).from("retell_calls");

// ─────────────────────────────────────────────────────────────────────────────
// The custom_analysis_data field-name contract.
//
// These are the exact keys the Retell dashboard's post-call analysis (and the
// mid-call capture-lead function) MUST populate — documented in
// docs/retell-integration.md. Each is read across a couple of aliases so minor
// naming drift in the dashboard doesn't silently drop a field.
// ─────────────────────────────────────────────────────────────────────────────
const FIELD = {
  name: ["caller_name", "name", "customer_name", "full_name"],
  email: ["caller_email", "email", "customer_email"],
  makeModel: ["boat_make_model", "make_model", "boat_model", "boat_make"],
  lengthFt: ["boat_length_ft", "boat_length", "length_ft"],
  boatType: ["boat_type", "boat_style"],
  engineType: ["engine_type", "engine"],
  engineCount: ["engine_count", "number_of_engines", "num_engines"],
  location: ["boat_location", "current_location", "location"],
  onTrailer: ["on_trailer", "is_on_trailer", "has_trailer", "trailer"],
  services: ["services_requested", "requested_services", "services", "service_type"],
  urgent: ["is_urgent", "urgent", "is_emergency", "time_sensitive"],
} as const;

export interface RetellCallFields {
  callId: string | null;
  agentId: string | null;
  direction: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  transcript: string | null;
  transcriptObject: unknown;
  callSummary: string | null;
  userSentiment: string | null;
  callSuccessful: boolean | null;
  inVoicemail: boolean | null;
  callAnalysis: unknown;
  customAnalysisData: unknown;
  event: string | null;
  /** call.metadata — arbitrary object we set when placing an outbound call (contactId, org, …). */
  metadata: Record<string, unknown> | null;
  // Extracted from custom_analysis_data:
  name: string | null;
  email: string | null;
  boatMakeModel: string | null;
  boatLengthFt: number | null;
  boatType: string | null;
  engineType: "outboard" | "sterndrive" | "inboard" | null;
  engineCount: number | null;
  boatLocation: string | null;
  onTrailer: boolean | null;
  servicesRequested: string[];
  urgent: boolean;
}

/** Read the extractable lead fields from a `custom_analysis_data`-shaped object. */
function readAnalysisFields(
  custom: unknown,
): Pick<
  RetellCallFields,
  | "name"
  | "email"
  | "boatMakeModel"
  | "boatLengthFt"
  | "boatType"
  | "engineType"
  | "engineCount"
  | "boatLocation"
  | "onTrailer"
  | "servicesRequested"
  | "urgent"
> {
  return {
    name: readString(custom, FIELD.name),
    email: readString(custom, FIELD.email),
    boatMakeModel: readString(custom, FIELD.makeModel),
    boatLengthFt: coerceBoatLengthFt(readFirst(custom, FIELD.lengthFt)),
    boatType: readString(custom, FIELD.boatType),
    engineType: coerceEngineType(readString(custom, FIELD.engineType)),
    engineCount: coerceEngineCount(readFirst(custom, FIELD.engineCount)),
    boatLocation: readString(custom, FIELD.location),
    onTrailer: readBoolean(custom, FIELD.onTrailer),
    servicesRequested: readStringArray(custom, FIELD.services),
    urgent: readBoolean(custom, FIELD.urgent) ?? false,
  };
}

/**
 * Pull fields from a `call_analyzed` webhook payload ({ event, call: {...} }). The
 * lead fields live in `call.call_analysis.custom_analysis_data`; the standard call
 * fields (transcript, numbers) live on the call object itself.
 */
export function readRetellCallFields(payload: unknown): RetellCallFields {
  const call = asRecord(readPath(payload, "call")) ?? asRecord(payload) ?? {};
  const analysis = readPath(call, "call_analysis") ?? null;
  const custom = readPath(call, "call_analysis.custom_analysis_data") ?? null;

  return {
    callId: readString(call, ["call_id", "callId"]),
    agentId: readString(call, ["agent_id", "agentId"]),
    direction: readString(call, ["direction"]),
    fromNumber: readString(call, ["from_number", "from"]),
    toNumber: readString(call, ["to_number", "to"]),
    transcript: readString(call, ["transcript"]),
    transcriptObject: readPath(call, "transcript_object") ?? null,
    callSummary: readString(call, ["call_analysis.call_summary"]),
    userSentiment: readString(call, ["call_analysis.user_sentiment"]),
    callSuccessful: readBoolean(call, ["call_analysis.call_successful"]),
    inVoicemail: readBoolean(call, ["call_analysis.in_voicemail"]),
    callAnalysis: analysis,
    customAnalysisData: custom,
    event: readString(payload, ["event"]),
    metadata: asRecord(readPath(call, "metadata")),
    ...readAnalysisFields(custom),
  };
}

/**
 * Pull fields from a mid-call custom-function invocation. Retell posts
 * `{ call: { call_id, from_number, ... }, name, args: {...} }` where `args` is the
 * function's arguments object — so the lead fields are read from `args` and the
 * call identity from `call`.
 */
export function readRetellFunctionFields(payload: unknown): RetellCallFields {
  const call = asRecord(readPath(payload, "call")) ?? {};
  const args = readPath(payload, "args") ?? readPath(payload, "arguments") ?? payload;

  return {
    callId: readString(call, ["call_id", "callId"]) ?? readString(payload, ["call_id", "callId"]),
    agentId: readString(call, ["agent_id", "agentId"]),
    direction: readString(call, ["direction"]),
    fromNumber:
      readString(call, ["from_number", "from"]) ?? readString(args, ["phone", "from_number", "caller_phone"]),
    toNumber: readString(call, ["to_number", "to"]),
    transcript: null,
    transcriptObject: null,
    callSummary: readString(args, ["summary", "notes", "call_summary"]),
    userSentiment: null,
    callSuccessful: null,
    inVoicemail: null,
    callAnalysis: null,
    customAnalysisData: asRecord(args) ?? null,
    event: "capture_lead",
    metadata: asRecord(readPath(call, "metadata")),
    ...readAnalysisFields(args),
  };
}

/**
 * Map the captured fields onto the canonical lead envelope (schemaVersion 1) that
 * every spoke emits, so a phone lead flows through the identical intake / dedup /
 * notification path as a web form.
 *
 * Returned untyped on purpose: intake re-validates with its own zod schema and is
 * designed to SORT invalid payloads (store raw + flag) rather than reject them, so an
 * incomplete call still lands in raw_leads instead of being dropped here. Optional
 * fields are only emitted when present, so the built envelope stays compact.
 */
export function buildPhoneLeadEnvelope(
  fields: RetellCallFields,
  sourceSite: string,
  leadSource: string,
  receivedAt: string = new Date().toISOString(),
): Record<string, unknown> {
  // Human-readable message: the summary, plus structured facts it may omit, so the
  // notification email is self-contained.
  const messageParts: string[] = [];
  if (fields.callSummary) messageParts.push(fields.callSummary);
  if (fields.servicesRequested.length > 0) {
    messageParts.push(`Services requested: ${fields.servicesRequested.join(", ")}.`);
  }
  const boatBits: string[] = [];
  if (fields.boatLengthFt != null) boatBits.push(`${fields.boatLengthFt}ft`);
  if (fields.boatType) boatBits.push(fields.boatType);
  if (fields.engineType || fields.engineCount != null) {
    const count = fields.engineCount != null ? String(fields.engineCount) : "";
    const plural = fields.engineCount != null && fields.engineCount !== 1 ? "s" : "";
    boatBits.push(`${count} ${fields.engineType ?? ""} engine${plural}`.trim().replace(/\s+/g, " "));
  }
  if (fields.onTrailer != null) boatBits.push(fields.onTrailer ? "on a trailer" : "in the water");
  if (fields.boatLocation) boatBits.push(`at ${fields.boatLocation}`);
  if (boatBits.length > 0) messageParts.push(`Boat: ${boatBits.join(", ")}.`);
  if (fields.callId) messageParts.push(`Retell call: ${fields.callId}.`);

  const asset: Record<string, unknown> = {};
  if (fields.boatMakeModel) asset.makeModel = fields.boatMakeModel;
  if (fields.boatLengthFt != null) asset.lengthFt = fields.boatLengthFt;
  if (fields.boatType) asset.type = fields.boatType;
  if (fields.engineType) asset.engineType = fields.engineType;
  if (fields.engineCount != null) asset.engineCount = fields.engineCount;
  if (fields.onTrailer != null) asset.onTrailer = fields.onTrailer;
  if (fields.boatLocation) asset.location = fields.boatLocation;

  const meta: Record<string, unknown> = { site: "retell" };
  if (fields.urgent) meta.urgent = true;
  if (fields.callId) meta.retell = { callId: fields.callId };

  const phone = toE164(fields.fromNumber) ?? fields.fromNumber ?? null;

  return {
    schemaVersion: LEAD_SCHEMA_VERSION,
    source: leadSource,
    sourceSite,
    formType: "phone-lead",
    receivedAt,
    contact: {
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.email ? { email: fields.email } : {}),
      ...(phone ? { phone } : {}),
    },
    ...(messageParts.length > 0 ? { message: messageParts.join(" ") } : {}),
    ...(fields.servicesRequested.length > 0 ? { services: fields.servicesRequested } : {}),
    ...(Object.keys(asset).length > 0 ? { asset } : {}),
    meta,
  };
}

export interface RetellIngestResult {
  duplicate: boolean;
  leadId: string | null;
  callId: string;
  urgent: boolean;
}

/** Persist the raw call (durable + transcript store). Upsert on call_id so a retry —
 *  or the later call_analyzed after a mid-call capture — enriches the same row. */
async function upsertRetellCall(
  admin: RetellAdminClient,
  args: {
    callId: string;
    tenant: RetellTenant;
    fields: RetellCallFields;
    rawPayload: unknown;
    leadId?: string | null;
    contactId?: string | null;
  },
): Promise<void> {
  const { callId, tenant, fields, rawPayload, leadId, contactId } = args;
  const row: Record<string, unknown> = {
    organization_id: tenant.organizationId,
    company_id: tenant.companyId,
    call_id: callId,
    agent_id: fields.agentId,
    direction: fields.direction,
    from_number: fields.fromNumber,
    to_number: fields.toNumber,
    caller_phone_last10: normalizePhoneLast10(fields.fromNumber),
    transcript: fields.transcript,
    transcript_object: (fields.transcriptObject ?? null) as Json,
    call_summary: fields.callSummary,
    user_sentiment: fields.userSentiment,
    call_successful: fields.callSuccessful,
    in_voicemail: fields.inVoicemail,
    call_analysis: (fields.callAnalysis ?? null) as Json,
    custom_analysis_data: (fields.customAnalysisData ?? null) as Json,
    is_urgent: fields.urgent,
    event: fields.event,
    raw_payload: (rawPayload ?? {}) as Json,
    received_at: new Date().toISOString(),
  };
  if (leadId) row.lead_id = leadId;
  if (contactId) row.contact_id = contactId;
  const { error } = await retellCalls(admin).upsert(row, { onConflict: "call_id" });
  if (error) throw error;
}

/**
 * Durable-first phone-lead ingest, shared by the webhook (call_analyzed) and the
 * mid-call capture-lead function:
 *   1) idempotency by call_id — a retry, or a call_analyzed following a mid-call
 *      capture, attaches to the existing lead (still enriching the call row);
 *   2) DURABLE write of the raw call FIRST;
 *   3) map onto the canonical envelope → the SAME intake path as a web form;
 *   4) link the call row to the created lead (+ its contact).
 * Urgency escalation is carried by the envelope's meta.urgent, which intake turns
 * into a high-priority notification + needs-attention flag.
 */
async function runPhoneLeadIntake(fields: RetellCallFields, rawPayload: unknown): Promise<RetellIngestResult> {
  const cfg = getRetellConfig();
  const admin = createRetellAdminClient();
  const tenant = await resolveRetellTenant(admin, cfg.sourceSite);

  // call_analyzed / capture always carry a call_id; a synthetic id only guards a
  // pathological payload so the raw call is still stored durably.
  const callId = fields.callId ?? `retell_nocid_${randomBytes(8).toString("hex")}`;

  if (fields.callId) {
    const { data: existing } = await retellCalls(admin)
      .select("lead_id")
      .eq("call_id", fields.callId)
      .maybeSingle();
    if (existing?.lead_id) {
      // A lead already exists for this call (e.g. the mid-call capture created it).
      // Enrich the row with any newer transcript/analysis, but never create a second lead.
      await upsertRetellCall(admin, { callId, tenant, fields, rawPayload, leadId: existing.lead_id });
      return { duplicate: true, leadId: existing.lead_id, callId, urgent: fields.urgent };
    }
  }

  // (2) DURABLE-FIRST.
  await upsertRetellCall(admin, { callId, tenant, fields, rawPayload });

  // (3) Canonical envelope → SAME intake path as a form (dedup, activity, notify).
  const envelope = buildPhoneLeadEnvelope(fields, tenant.sourceSite, cfg.leadSource);
  const result = await handleLeadIntake(JSON.stringify(envelope), envelope);

  // (4) Link the call row to its lead + contact (best-effort; the lead is already durable).
  try {
    const { data: rawLead } = await admin
      .from("raw_leads")
      .select("contact_id")
      .eq("lead_id", result.leadId)
      .maybeSingle();
    await retellCalls(admin)
      .update({
        lead_id: result.leadId,
        contact_id: rawLead?.contact_id ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq("call_id", callId);
  } catch (err) {
    console.error("[retell:lead] failed to link call to lead:", err);
  }

  return { duplicate: false, leadId: result.leadId, callId, urgent: fields.urgent };
}

export interface RetellWebhookResult {
  handled: "inbound" | "outbound" | "skipped";
  leadId?: string | null;
}

/**
 * Is this a call WE placed (outbound)? Only outbound calls carry metadata.contactId (set
 * when dialing), so treat that as outbound even when the direction field is absent — but
 * never override an explicit `inbound`.
 */
export function isOutboundCall(fields: Pick<RetellCallFields, "direction" | "metadata">): boolean {
  return (
    fields.direction === "outbound" ||
    (typeof fields.metadata?.contactId === "string" && fields.direction !== "inbound")
  );
}

/**
 * Webhook path: ingest a `call_analyzed` payload. Branches on the call's direction:
 *   • outbound → a Marina call WE placed; log the OUTCOME on the existing contact (never a
 *     new lead), gated by RETELL_OUTBOUND_ENABLED;
 *   • inbound  → a caller reached the receptionist; run the phone-lead intake, gated by
 *     RETELL_INTAKE_ENABLED.
 */
export async function ingestRetellCall(payload: unknown): Promise<RetellWebhookResult> {
  const fields = readRetellCallFields(payload);
  const cfg = getRetellConfig();

  if (isOutboundCall(fields)) {
    if (!cfg.outboundEnabled) return { handled: "skipped" };
    await captureOutboundOutcome(fields, payload);
    return { handled: "outbound" };
  }

  if (!cfg.enabled) return { handled: "skipped" };
  const result = await runPhoneLeadIntake(fields, payload);
  return { handled: "inbound", leadId: result.leadId };
}

/**
 * An outbound Marina call ended. Store it durably (transcript + analysis, direction
 * outbound) and append `contact.call_completed` to the contact's timeline — matched by the
 * metadata we sent when placing the call. Never creates a lead.
 */
async function captureOutboundOutcome(fields: RetellCallFields, rawPayload: unknown): Promise<void> {
  const admin = createRetellAdminClient();
  const meta = fields.metadata ?? {};
  const contactId = typeof meta.contactId === "string" ? meta.contactId : null;
  const organizationId = typeof meta.organizationId === "string" ? meta.organizationId : null;
  const companyId = typeof meta.companyId === "string" ? meta.companyId : null;

  const callId = fields.callId ?? `retell_nocid_${randomBytes(8).toString("hex")}`;

  // Durable-first: store the outbound call. Upsert on call_id → idempotent on retries.
  await upsertRetellCall(admin, {
    callId,
    tenant: { organizationId, companyId, sourceSite: "" },
    fields,
    rawPayload,
    contactId,
  });

  // Log the outcome on the contact's timeline (best-effort; no new lead).
  if (contactId && organizationId) {
    try {
      const ctx = { organizationId, actorProfileId: null, supabase: admin } as unknown as TenantServiceContext;
      await createActivityEvent(ctx, {
        companyId,
        entityId: contactId,
        entityType: "contact",
        eventType: "contact.call_completed",
        metadata: {
          agent: "marina",
          provider: "retell",
          agentCallId: callId,
          channel: "voice",
          callStatus: fields.callSuccessful == null ? null : fields.callSuccessful ? "completed" : "failed",
          summary: fields.callSummary,
          userSentiment: fields.userSentiment,
          inVoicemail: fields.inVoicemail,
          toNumber: fields.toNumber,
        },
      });
    } catch (err) {
      console.error("[retell:outbound] failed to log call outcome:", err);
    }
  }
}

/** Mid-call custom-function path: ingest a capture-lead tool invocation. */
export async function captureRetellLead(payload: unknown): Promise<RetellIngestResult> {
  return runPhoneLeadIntake(readRetellFunctionFields(payload), payload);
}
