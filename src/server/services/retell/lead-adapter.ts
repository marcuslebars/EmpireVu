import { randomBytes } from "node:crypto";

import type { Inserts, Json } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { createActivityEvent } from "@/server/services/activity-events";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { LEAD_SCHEMA_VERSION } from "@/server/services/lead-intake/envelope";
import { handleLeadIntake } from "@/server/services/lead-intake/intake";
import type { TenantServiceContext } from "@/server/services/shared";
import { recordUsage } from "@/server/services/usage";
import { getRetellConfig } from "./config";
import {
  asRecord,
  coerceBoatLengthFt,
  coerceEngineCount,
  coerceEngineType,
  normalizePhoneLast10,
  readBoolean,
  readFirst,
  readNumber,
  readPath,
  readString,
  readStringArray,
  toE164,
} from "./payload";
import {
  createRetellAdminClient,
  pinnedRetellTenant,
  resolveRetellTenant,
  type RetellAdminClient,
  type RetellTenant,
} from "./tenant";
import { isVerifiedAnswerTenant, readAnswerMetadata, type VerifiedAnswerTenant } from "@/server/services/voice/ai-answer";
import { handleAnsweredCall } from "@/server/services/voice/post-call";

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
  recordingUrl: string | null;
  callSummary: string | null;
  userSentiment: string | null;
  callSuccessful: boolean | null;
  inVoicemail: boolean | null;
  callAnalysis: unknown;
  customAnalysisData: unknown;
  event: string | null;
  /** call.metadata — arbitrary object we set when placing an outbound call (contactId, org, …). */
  metadata: Record<string, unknown> | null;
  /** Why the call ended (e.g. "user_hangup", "call_transfer"); optional so hand-built fixtures stay valid. */
  disconnectionReason?: string | null;
  // Call metering (from the post-call analyzed payload; null for a mid-call capture):
  durationMs: number | null;
  startTimestamp: string | null;
  endTimestamp: string | null;
  callCostCents: number | null;
  costBreakdown: unknown;
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

/** Retell start/end timestamps are epoch milliseconds; store as ISO. */
function epochMsToIso(ms: number | null): string | null {
  return ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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

  // Metering fields (present on the post-call `call_analyzed` payload). Retell timestamps
  // are epoch ms; duration_ms is provided directly but fall back to end-start. call_cost
  // .combined_cost is already in cents.
  const startMs = readNumber(call, ["start_timestamp", "start_time"]);
  const endMs = readNumber(call, ["end_timestamp", "end_time"]);
  const durationMs =
    readNumber(call, ["duration_ms"]) ??
    (startMs != null && endMs != null && endMs >= startMs ? endMs - startMs : null);
  const combinedCost = readNumber(call, [
    "call_cost.combined_cost",
    "call_cost.total_cost",
    "combined_cost",
  ]);

  return {
    callId: readString(call, ["call_id", "callId"]),
    agentId: readString(call, ["agent_id", "agentId"]),
    direction: readString(call, ["direction"]),
    fromNumber: readString(call, ["from_number", "from"]),
    toNumber: readString(call, ["to_number", "to"]),
    transcript: readString(call, ["transcript"]),
    transcriptObject: readPath(call, "transcript_object") ?? null,
    recordingUrl: readString(call, ["recording_url", "recordingUrl"]),
    callSummary: readString(call, ["call_analysis.call_summary"]),
    userSentiment: readString(call, ["call_analysis.user_sentiment"]),
    callSuccessful: readBoolean(call, ["call_analysis.call_successful"]),
    inVoicemail: readBoolean(call, ["call_analysis.in_voicemail"]),
    callAnalysis: analysis,
    customAnalysisData: custom,
    event: readString(payload, ["event"]),
    metadata: asRecord(readPath(call, "metadata")),
    disconnectionReason: readString(call, ["disconnection_reason"]) ?? undefined,
    durationMs,
    startTimestamp: epochMsToIso(startMs),
    endTimestamp: epochMsToIso(endMs),
    callCostCents: combinedCost != null ? Math.round(combinedCost) : null,
    costBreakdown: readPath(call, "call_cost") ?? null,
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
    recordingUrl: readString(call, ["recording_url", "recordingUrl"]),
    callSummary: readString(args, ["summary", "notes", "call_summary"]),
    userSentiment: null,
    callSuccessful: null,
    inVoicemail: null,
    callAnalysis: null,
    customAnalysisData: asRecord(args) ?? null,
    event: "capture_lead",
    metadata: asRecord(readPath(call, "metadata")),
    // A mid-call capture carries no post-call metering.
    durationMs: null,
    startTimestamp: null,
    endTimestamp: null,
    callCostCents: null,
    costBreakdown: null,
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
  const row: Inserts<"retell_calls"> = {
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
    recording_url: fields.recordingUrl,
    call_summary: fields.callSummary,
    user_sentiment: fields.userSentiment,
    call_successful: fields.callSuccessful,
    in_voicemail: fields.inVoicemail,
    call_analysis: (fields.callAnalysis ?? null) as Json,
    custom_analysis_data: (fields.customAnalysisData ?? null) as Json,
    is_urgent: fields.urgent,
    event: fields.event,
    duration_ms: fields.durationMs,
    start_timestamp: fields.startTimestamp,
    end_timestamp: fields.endTimestamp,
    call_cost_cents: fields.callCostCents,
    cost_breakdown: (fields.costBreakdown ?? null) as Json,
    raw_payload: (rawPayload ?? {}) as Json,
    received_at: new Date().toISOString(),
  };
  if (leadId) row.lead_id = leadId;
  if (contactId) row.contact_id = contactId;
  const { error } = await admin.from("retell_calls").upsert(row, { onConflict: "call_id" });
  if (error) throw error;

  // Meter voice minutes (Task 6). Idempotent on call_id, so the enrich/retry paths and a
  // duplicate delivery record it once. Only the post-call analyzed payload carries a
  // duration; a mid-call capture (durationMs null) records nothing. Best-effort: a
  // metering write must never fail ingest.
  if (tenant.organizationId && fields.durationMs != null && fields.durationMs > 0) {
    try {
      await recordUsage(admin, {
        organizationId: tenant.organizationId,
        companyId: tenant.companyId,
        kind: "voice_minutes",
        quantity: fields.durationMs / 60000,
        unit: "minutes",
        costCents: fields.callCostCents ?? null,
        provider: "retell",
        providerRef: callId,
        occurredAt: fields.endTimestamp ?? undefined,
        metadata: { direction: fields.direction, callId },
      });
    } catch (err) {
      console.error("[retell] failed to meter voice minutes:", err instanceof Error ? err.message : err);
    }
  }
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
interface PhoneLeadIntakeOptions {
  /** A tenant we already pinned (AI-answered catcher call, token-verified) — skips number/agent/legacy resolution. */
  tenant?: RetellTenant;
  /**
   * Record the call.* triggers on the timeline WITHOUT running workflows. AI-answered catcher
   * calls do their own owner alert + single follow-up text (voice/post-call.ts), so the
   * call.missed text-back / call-summary recipes must not fire on top.
   */
  triggersEmitOnly?: boolean;
}

async function runPhoneLeadIntake(
  fields: RetellCallFields,
  rawPayload: unknown,
  options: PhoneLeadIntakeOptions = {},
): Promise<RetellIngestResult> {
  const cfg = getRetellConfig();
  const admin = createRetellAdminClient();
  // Inbound tenant: pinned by us, else by dialled number → by agent → legacy env (Task 7).
  const tenant =
    options.tenant ??
    (await resolveRetellTenant(admin, {
      toNumber: fields.toNumber,
      agentId: fields.agentId,
      legacySourceSite: cfg.sourceSite,
    }));

  // call_analyzed / capture always carry a call_id; a synthetic id only guards a
  // pathological payload so the raw call is still stored durably.
  const callId = fields.callId ?? `retell_nocid_${randomBytes(8).toString("hex")}`;

  if (fields.callId) {
    const { data: existing } = await admin.from("retell_calls")
      .select("lead_id")
      .eq("call_id", fields.callId)
      .maybeSingle();
    if (existing?.lead_id) {
      // A lead already exists for this call (e.g. the mid-call capture created it).
      // Enrich the row with any newer transcript/analysis, but never create a second lead.
      await upsertRetellCall(admin, { callId, tenant, fields, rawPayload, leadId: existing.lead_id });

      // The call.* triggers belong to the END of the call. When a mid-call tool (capture-lead,
      // Marina's quote) filed the lead, they were deliberately held back — so the post-call
      // payload fires them now, exactly once.
      if (isPostCall(fields) && !(await callTriggersEmitted(admin, tenant.organizationId, callId))) {
        const { data: linked } = await admin.from("retell_calls")
          .select("contact_id")
          .eq("call_id", callId)
          .maybeSingle();
        await emitRetellCallTriggers(admin, {
          organizationId: tenant.organizationId,
          companyId: tenant.companyId,
          contactId: (linked as { contact_id: string | null } | null)?.contact_id ?? null,
          fields,
          emitOnly: options.triggersEmitOnly,
        });
      }
      return { duplicate: true, leadId: existing.lead_id, callId, urgent: fields.urgent };
    }
  }

  // (2) DURABLE-FIRST.
  await upsertRetellCall(admin, { callId, tenant, fields, rawPayload });

  // (3) Canonical envelope → SAME intake path as a form (dedup, activity, notify). The
  //     tenant is PINNED from the resolved number/agent, so a brand-new tenant routes even
  //     though its sourceSite tag isn't in the legacy A1 map. When nothing resolved
  //     (org null), fall back to sourceSite routing (stores raw + flags if still unmapped).
  const envelope = buildPhoneLeadEnvelope(fields, tenant.sourceSite, cfg.leadSource);
  const result = await handleLeadIntake(
    JSON.stringify(envelope),
    envelope,
    tenant.organizationId
      ? { target: { organizationId: tenant.organizationId, companyId: tenant.companyId } }
      : {},
  );

  // (4) Link the call row to its lead + contact (best-effort; the lead is already durable).
  let linkedContactId: string | null = null;
  try {
    const { data: rawLead } = await admin
      .from("raw_leads")
      .select("contact_id")
      .eq("lead_id", result.leadId)
      .maybeSingle();
    linkedContactId = (rawLead as { contact_id: string | null } | null)?.contact_id ?? null;
    await admin.from("retell_calls")
      .update({
        lead_id: result.leadId,
        contact_id: linkedContactId,
        processed_at: new Date().toISOString(),
      })
      .eq("call_id", callId);
  } catch (err) {
    console.error("[retell:lead] failed to link call to lead:", err);
  }

  // (5) Task 9 triggers: call.missed / call.completed (+ call.urgent) — only once the call
  //     is OVER. A mid-call capture has no duration, voicemail flag or summary yet, and
  //     classifying it would fire "call completed" automations while the caller is still on
  //     the line; the post-call payload fires them via the duplicate path above instead.
  if (isPostCall(fields)) {
    await emitRetellCallTriggers(admin, {
      organizationId: tenant.organizationId,
      companyId: tenant.companyId,
      contactId: linkedContactId,
      fields,
      emitOnly: options.triggersEmitOnly,
    });
  }

  return { duplicate: false, leadId: result.leadId, callId, urgent: fields.urgent };
}

/** A mid-call tool invocation (capture-lead, Marina's quote) is not the end of the call. */
export function isPostCall(fields: Pick<RetellCallFields, "event">): boolean {
  return fields.event !== "capture_lead";
}

/** Have this call's call.* triggers already fired? (Keyed by the Retell call id in the
 *  event metadata; the webhook queue already dedupes redeliveries, this guards the
 *  capture → analyzed hand-off.) Fails toward "not yet" only when the lookup itself works. */
async function callTriggersEmitted(
  admin: RetellAdminClient,
  organizationId: string | null,
  callId: string,
): Promise<boolean> {
  if (!organizationId) return true; // nothing would be emitted anyway
  const { data, error } = await admin.from("activity_events")
    .select("id")
    .eq("organization_id", organizationId)
    .in("event_type", ["call.missed", "call.completed"])
    .eq("metadata_json->>callId", callId)
    .limit(1);
  if (error) {
    console.error("[retell] could not check call triggers; not re-firing:", error.message);
    return true;
  }
  return (data ?? []).length > 0;
}

/** call.missed = inbound reached voicemail, ended in <5s, or was not successful; else
 *  call.completed. Precise + exported for tests/docs (docs/retell-integration.md). */
export function classifyRetellCall(fields: Pick<RetellCallFields, "durationMs" | "inVoicemail" | "callSuccessful">): "missed" | "completed" {
  const tooShort = fields.durationMs != null && fields.durationMs < 5000;
  if (fields.inVoicemail === true || tooShort || fields.callSuccessful === false) {
    return "missed";
  }
  return "completed";
}

/** Emit the call.* workflow triggers for a processed call. Anchored to the contact when
 *  known, else the company. Best-effort — never fails ingest. */
async function emitRetellCallTriggers(
  admin: RetellAdminClient,
  args: { organizationId: string | null; companyId: string | null; contactId: string | null; fields: RetellCallFields; emitOnly?: boolean },
): Promise<void> {
  if (!args.organizationId) return;
  const dispatchOptions = args.emitOnly ? { emitOnly: true } : {};
  const anchorId = args.contactId ?? args.companyId;
  if (!anchorId) return;
  const anchorType = args.contactId ? "contact" : "company";
  const context: TenantServiceContext = {
    organizationId: args.organizationId,
    actorProfileId: null,
    supabase: admin,
  };
  const base = {
    companyId: args.companyId,
    entityId: anchorId,
    entityType: anchorType,
    metadata: {
      callId: args.fields.callId,
      contactId: args.contactId,
      direction: args.fields.direction,
      durationMs: args.fields.durationMs,
      inVoicemail: args.fields.inVoicemail,
      callSuccessful: args.fields.callSuccessful,
    },
  };
  try {
    const kind = classifyRetellCall(args.fields);
    await emitActivityEventAndDispatch(
      context,
      {
        ...base,
        eventType: kind === "missed" ? "call.missed" : "call.completed",
        ...(args.emitOnly ? { metadata: { ...base.metadata, aiAnswered: true } } : {}),
      },
      dispatchOptions,
    );
    if (args.fields.urgent) {
      await emitActivityEventAndDispatch(context, { ...base, eventType: "call.urgent" }, dispatchOptions);
    }
    if (!args.emitOnly && args.companyId && looksAbandoned(args.fields)) {
      const callerLast10 = normalizePhoneLast10(args.fields.fromNumber);
      if (callerLast10 && (await shouldSendRecovery(admin, { ...args, companyId: args.companyId, callerLast10 }))) {
        await emitActivityEventAndDispatch(context, {
          ...base,
          eventType: "call.abandoned",
          metadata: { ...base.metadata, callerLast10 },
        });
      }
    }
  } catch (err) {
    console.error("[retell] failed to emit call triggers:", err instanceof Error ? err.message : err);
  }
}

// ── Hung up before a quote (ported from a1marinecare/src/lib/retell/followups.ts) ─────────

const RECOVERY_COOLDOWN_DAYS = 7;
const KNOWN_CALLER_LOOKBACK_DAYS = 120;

/**
 * PURE — an inbound call that got far enough to be about the service (≥15s, mentions shrink
 * wrap / winterizing) but ended without a transfer or voicemail. Same test as the Care site.
 */
export function looksAbandoned(
  fields: Pick<
    RetellCallFields,
    "direction" | "fromNumber" | "durationMs" | "inVoicemail" | "disconnectionReason" | "servicesRequested" | "callSummary" | "transcript"
  >,
): boolean {
  if (fields.direction && fields.direction !== "inbound") return false;
  if (!fields.fromNumber) return false;
  if (fields.durationMs == null || fields.durationMs < 15_000) return false;
  if ((fields.disconnectionReason ?? "").includes("transfer")) return false;
  if (fields.inVoicemail === true) return false;
  const text = [fields.servicesRequested.join(" "), fields.callSummary ?? "", (fields.transcript ?? "").slice(0, 4000)].join(" ");
  return /shrink|wrap|winteri[sz]/i.test(text);
}

/** No quote on this call, not a returning customer, no recovery text to this number in 7 days. */
async function shouldSendRecovery(
  admin: RetellAdminClient,
  args: { organizationId: string | null; companyId: string; contactId: string | null; callerLast10: string; fields: RetellCallFields },
): Promise<boolean> {
  if (!args.organizationId || !args.fields.callId) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as any;
  const { data: call } = await db.from("retell_calls").select("lead_id").eq("call_id", args.fields.callId).maybeSingle();
  const leadId = (call as { lead_id: string | null } | null)?.lead_id ?? null;
  if (leadId) {
    const { data: quoteOnCall } = await db.from("quotes").select("id").eq("source_lead_id", leadId).limit(1).maybeSingle();
    if (quoteOnCall) return false;
  }
  if (args.contactId) {
    const since = new Date(Date.now() - KNOWN_CALLER_LOOKBACK_DAYS * 86_400_000).toISOString();
    const { data: priorQuote } = await db
      .from("quotes")
      .select("id")
      .eq("organization_id", args.organizationId)
      .eq("company_id", args.companyId)
      .eq("contact_id", args.contactId)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();
    if (priorQuote) return false;
  }
  const cooldown = new Date(Date.now() - RECOVERY_COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data: recent } = await db
    .from("activity_events")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("company_id", args.companyId)
    .eq("event_type", "call.abandoned")
    .eq("metadata_json->>callerLast10", args.callerLast10)
    .gte("created_at", cooldown)
    .limit(1);
  return (recent ?? []).length === 0;
}

/**
 * Retell `call_started` for an inbound call → `call.started` (the owner's "📞 answering a call
 * from…" text). Best-effort and quick: resolve the company by the dialled number, emit, done.
 * Workflows run on the worker, so the webhook ACKs immediately.
 */
export async function announceCallStarted(payload: unknown): Promise<void> {
  const fields = readRetellCallFields(payload);
  if (isOutboundCall(fields) || !getRetellConfig().enabled) return;
  const admin = createRetellAdminClient();
  // An AI-answered catcher call carries its tenant in signed metadata; one that claims to and
  // doesn't verify is never announced (and never falls through to the legacy guess).
  const answered = readAnswerMetadata(fields.metadata);
  if (answered && !isVerifiedAnswerTenant(answered)) return;
  const tenant = isVerifiedAnswerTenant(answered)
    ? await pinnedRetellTenant(admin, answered.organizationId, answered.companyId)
    : await resolveRetellTenant(admin, {
        toNumber: fields.toNumber,
        agentId: fields.agentId,
        legacySourceSite: getRetellConfig().sourceSite,
      });
  if (!tenant.organizationId || !tenant.companyId || tenant.resolvedBy === "legacy") return;
  const context: TenantServiceContext = { organizationId: tenant.organizationId, actorProfileId: null, supabase: admin };
  await emitActivityEventAndDispatch(context, {
    companyId: tenant.companyId,
    entityId: tenant.companyId,
    entityType: "company",
    eventType: "call.started",
    metadata: {
      callId: fields.callId,
      direction: fields.direction ?? "inbound",
      callerNumber: fields.fromNumber,
      startedAt: fields.startTimestamp ?? new Date().toISOString(),
    },
  });
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

  // AI-answered catcher call (docs/front-desk-ai.md → "## Phone answering").
  const answered = readAnswerMetadata(fields.metadata);
  if (answered) return ingestAnsweredCall(fields, payload, answered);

  const result = await runPhoneLeadIntake(fields, payload);
  return { handled: "inbound", leadId: result.leadId };
}

/**
 * A call our catcher handed to the AI. The tenant comes ONLY from the HMAC-verified metadata
 * we set at registration — a payload that claims to be one but doesn't verify is stored
 * durably with NO tenant and no lead (never re-routed by number/agent/legacy guess).
 */
async function ingestAnsweredCall(
  fields: RetellCallFields,
  payload: unknown,
  answered: VerifiedAnswerTenant | { valid: false },
): Promise<RetellWebhookResult> {
  const admin = createRetellAdminClient();
  if (!isVerifiedAnswerTenant(answered)) {
    console.error(`[retell] AI-answer call ${fields.callId ?? "?"} has metadata that doesn't verify — stored without a tenant.`);
    await upsertRetellCall(admin, {
      callId: fields.callId ?? `retell_nocid_${randomBytes(8).toString("hex")}`,
      tenant: { organizationId: null, companyId: null, sourceSite: "" },
      fields,
      rawPayload: payload,
    });
    return { handled: "skipped" };
  }
  const tenant = await pinnedRetellTenant(admin, answered.organizationId, answered.companyId);
  const result = await runPhoneLeadIntake(fields, payload, { tenant, triggersEmitOnly: true });
  if (isPostCall(fields)) {
    const { data: linked } = await admin.from("retell_calls").select("contact_id").eq("call_id", result.callId).maybeSingle();
    await handleAnsweredCall(admin, {
      tenant: answered,
      fields,
      leadId: result.leadId,
      contactId: (linked as { contact_id: string | null } | null)?.contact_id ?? null,
    });
  }
  return { handled: "inbound", leadId: result.leadId };
}

/**
 * Durable-first landing write for the webhook route: persist the raw call into
 * retell_calls (INSERT … ON CONFLICT (call_id) DO NOTHING) BEFORE the route enqueues
 * and ACKs, so the call is never lost between the 200 and processing. Deliberately a
 * do-nothing insert: it never clobbers a row an earlier event (e.g. a mid-call
 * capture) already enriched — the worker's ingestRetellCall does the full, tenant
 * -resolved upsert. Returns the call_id (used as the inbound_webhook_jobs external_id).
 */
export async function persistRetellCallRaw(admin: RetellAdminClient, payload: unknown): Promise<string> {
  const fields = readRetellCallFields(payload);
  const callId = fields.callId ?? `retell_nocid_${randomBytes(8).toString("hex")}`;
  const { error } = await admin.from("retell_calls").upsert(
    { call_id: callId, raw_payload: toJson(payload), received_at: new Date().toISOString() },
    { onConflict: "call_id", ignoreDuplicates: true },
  );
  if (error) {
    throw error;
  }
  return callId;
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
      const ctx: TenantServiceContext = { organizationId, actorProfileId: null, supabase: admin };
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
  const fields = readRetellFunctionFields(payload);
  // A receptionist answering a catcher call: the tenant is the one in the signed metadata.
  const answered = readAnswerMetadata(fields.metadata);
  if (answered) {
    if (!isVerifiedAnswerTenant(answered)) throw new Error("AI-answer call metadata doesn't verify — not capturing.");
    const tenant = await pinnedRetellTenant(createRetellAdminClient(), answered.organizationId, answered.companyId);
    return runPhoneLeadIntake(fields, payload, { tenant, triggersEmitOnly: true });
  }
  return runPhoneLeadIntake(fields, payload);
}
