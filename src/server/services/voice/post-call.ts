// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4 (Retell, continued — AI-answered catcher calls): runs from the
// Retell webhook worker / a Retell tool call with the service-role client. The tenant is the
// one in the call's metadata ONLY after its HMAC token verified (readAnswerMetadata), and
// every read/write below is filtered by that organization_id + company_id.
// docs/front-desk-ai.md → "## Phone answering".
// ─────────────────────────────────────────────────────────────────────────────
/**
 * After an AI-answered catcher call:
 *   1) mark the call handled (missed_calls 'ai_pending' → 'ai_handled'), link lead + contact;
 *   2) alert the owner with a short summary (urgent flagged; email too when urgent) — once;
 *   3) ONE follow-up text to the caller from the company number, continuing the conversation
 *      ("here's our booking link" / "we'll call you back") — instead of the generic "sorry we
 *      missed you" text-back, which never fires for an AI-handled call;
 *   4) seed the SMS conversation (sms_conversations.collected / summary) so the texting AI
 *      picks up with context.
 * Plus the mid-call "urgent" tool (runUrgentAlert): the owner is alerted while the caller is
 * still on the line.
 *
 * Every send is claim-then-send on the missed_calls row (owner_alerted_at, ai_followup_at,
 * ai_urgent_alerted_at), so a webhook retry never repeats one.
 */
import type { Json, Tables } from "@/server/db/database.types";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import type { RetellCallFields } from "@/server/services/retell/lead-adapter";
import { toE164 } from "@/server/services/retell/payload";
import { bookingPageUrl } from "@/server/services/scheduling/urls";
import type { TenantServiceContext } from "@/server/services/shared";
import { isAnonymousCaller } from "@/server/services/twilio/missed-call";
import { deliverMessage, resolveOwnerContacts, type ConsentContact, type DeliverMessageInput, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { prettyPhone } from "@/server/services/retell/call-summary";
import type { VerifiedAnswerTenant } from "@/server/services/voice/ai-answer";
import { VOICE_AGENT_SENDER } from "@/server/services/front-desk/contracts";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type MissedCallRow = Tables<"missed_calls">;

// ── What the caller told the AI (post-call analysis) ─────────────────────────────

export type Urgency = "emergency" | "urgent" | "normal";

export interface AnswerDetails {
  name: string | null;
  callbackNumber: string | null;
  job: string | null;
  address: string | null;
  urgency: Urgency;
  wantsCallback: boolean;
  wantsBookingLink: boolean;
  callbackTime: string | null;
  doNotText: boolean;
  summary: string | null;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max = 300): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t || /^(n\/?a|none|null|unknown|not provided)$/i.test(t)) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|y|1)$/i.test(value.trim());
  return false;
}

function first(source: Record<string, unknown>, keys: string[], max?: number): string | null {
  for (const key of keys) {
    const v = text(source[key], max);
    if (v) return v;
  }
  return null;
}

/**
 * Read the message-taking fields the agent's post-call analysis fills (field names in
 * MESSAGE_AGENT_ANALYSIS_FIELDS, message-agent.ts) — with the receptionist's names as aliases.
 * Caller speech is DATA: these values are only ever shown to the owner or slotted into fixed
 * templates, never executed or used to pick a tenant. Pure.
 */
export function readAnswerDetails(fields: Pick<RetellCallFields, "customAnalysisData" | "callSummary" | "urgent" | "name" | "servicesRequested">): AnswerDetails {
  const c = rec(fields.customAnalysisData);
  const urgencyRaw = (first(c, ["urgency", "urgency_level"]) ?? "").toLowerCase();
  const urgency: Urgency = /emergenc/.test(urgencyRaw)
    ? "emergency"
    : /urgent|asap|today/.test(urgencyRaw) || fields.urgent || bool(c.is_emergency)
      ? "urgent"
      : "normal";
  const next = (first(c, ["next_step", "caller_wants", "wants"]) ?? "").toLowerCase();
  return {
    name: fields.name ?? first(c, ["caller_name", "name"], 80),
    callbackNumber: first(c, ["callback_number", "phone", "best_number"], 30),
    job: first(c, ["job_description", "job", "what_they_need"], 200) ?? (fields.servicesRequested.length ? fields.servicesRequested.join(", ") : null),
    address: first(c, ["service_address", "address", "town", "location"], 160),
    urgency: bool(c.is_emergency) || urgency === "emergency" ? "emergency" : urgency,
    wantsCallback: bool(c.callback_requested) || /call ?back/.test(next),
    wantsBookingLink: bool(c.booking_link_requested) || /book|link/.test(next),
    callbackTime: first(c, ["callback_time", "best_time"], 60),
    doNotText: bool(c.do_not_text),
    summary: text(fields.callSummary, 600),
  };
}

function firstName(name: string | null): string | null {
  const f = name?.trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-zÀ-ÿ'’-]{2,30}$/.test(f) ? f : null;
}

/**
 * Caller speech echoed into a text that goes to a (spoofable) caller ID: only plain words. A
 * link, domain, email, long number, money or anything else odd → null (the template then uses a
 * generic phrase), so a caller can't make the business text someone a link or an offer. PURE.
 */
export function safeEcho(raw: string | null | undefined, max: number): string | null {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (/https?:|www\.|@|\b[a-z0-9-]+\.(?:com|ca|net|org|io|co|app|ly|me|info|biz|xyz|link|gl)\b|\$|%|\d{3,}|crank\s?leads|empire\s?vu/i.test(t)) return null;
  if (!/^[A-Za-zÀ-ÿ0-9 ,.'’&/:()-]+$/.test(t)) return null;
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** The caller's follow-up text. Fixed templates; the caller's own words appear only via safeEcho. Pure. */
export function buildFollowUpText(input: {
  companyName: string;
  details: AnswerDetails;
  bookingUrl: string | null;
  /** The call got far enough to take a message (vs. a hang-up after the greeting). */
  tookMessage: boolean;
}): string {
  const hi = `Hi ${firstName(input.details.name) ?? "there"}`;
  const company = input.companyName;
  if (!input.tookMessage) {
    return input.bookingUrl
      ? `${hi}, it's ${company} — sorry we couldn't finish your call. Book here: ${input.bookingUrl} or reply and we'll call you back.`
      : `${hi}, it's ${company} — sorry we couldn't finish your call. Reply here and we'll call you back.`;
  }
  if (input.details.urgency !== "normal") {
    return `${hi}, it's ${company}. Thanks for calling — we've flagged this as urgent and the team has been alerted. We'll call you back as soon as we can. Reply here if anything changes.`;
  }
  const job = safeEcho(input.details.job, 60);
  const about = job ? ` about ${job}` : "";
  if (input.bookingUrl && input.details.wantsBookingLink && !input.details.wantsCallback) {
    return `${hi}, thanks for calling ${company}! Here's our booking link to pick a time: ${input.bookingUrl} — or just reply here with any questions.`;
  }
  const callbackTime = safeEcho(input.details.callbackTime, 30);
  const when = callbackTime ? ` ${callbackTime.replace(/^(at|on)\s+/i, "")}` : " soon";
  const link = input.bookingUrl && !input.details.wantsCallback ? ` You can also book here: ${input.bookingUrl}` : "";
  return `${hi}, thanks for calling ${company}. We got your message${about} — someone will call you back${when}.${link} Reply here if anything changes.`;
}

/** The owner's alert. Pure. */
export function buildOwnerAlert(input: {
  companyName: string;
  details: AnswerDetails;
  callerNumber: string | null;
  durationMs: number | null;
  followUp: "sent" | "skipped" | "failed" | "not_ours" | "already_done";
}): { sms: string; subject: string; email: string } {
  const d = input.details;
  const who = [d.name, input.callerNumber ? prettyPhone(input.callerNumber) : "private number"].filter(Boolean).join(" · ");
  const callback = d.callbackNumber && toE164(d.callbackNumber) !== toE164(input.callerNumber) ? ` Callback: ${prettyPhone(d.callbackNumber)}.` : "";
  const what = [d.job, d.address].filter(Boolean).join(" — ");
  const ask = d.wantsCallback ? ` Wants a callback${d.callbackTime ? ` ${d.callbackTime}` : ""}.` : d.wantsBookingLink ? " Wants to book." : "";
  const texted =
    input.followUp === "sent" ? " We texted them to follow up." : input.followUp === "failed" ? " Our follow-up text didn't go — text them yourself." : "";
  const head =
    d.urgency === "emergency"
      ? `🚨 EMERGENCY call for ${input.companyName}`
      : d.urgency === "urgent"
        ? `🚨 Urgent call for ${input.companyName}`
        : `📞 Your AI assistant took a call for ${input.companyName}`;
  const sms = `${head}: ${who}.${what ? ` ${what}.` : ""}${callback}${ask}${d.urgency !== "normal" ? " Call them back now." : ""}${texted}`;
  const subject = `${d.urgency !== "normal" ? "🚨 Urgent: " : ""}Call from ${who}`;
  const email = [
    sms,
    "",
    d.summary ? `Summary: ${d.summary}` : null,
    input.durationMs ? `Call length: ${Math.max(1, Math.round(input.durationMs / 1000))}s` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return { sms: sms.length > 600 ? `${sms.slice(0, 597)}…` : sms, subject, email };
}

// ── Effects (injectable) ───────────────────────────────────────────────────────

export interface PostCallDeps {
  send(input: DeliverMessageInput): Promise<DeliverMessageResult>;
  now(): Date;
}

export const defaultPostCallDeps: PostCallDeps = {
  send: (input) => deliverMessage(input),
  now: () => new Date(),
};

async function loadRow(admin: AdminClient, tenant: VerifiedAnswerTenant): Promise<MissedCallRow | null> {
  const { data, error } = await admin
    .from("missed_calls")
    .select("*")
    .eq("call_sid", tenant.callSid)
    .eq("organization_id", tenant.organizationId)
    .eq("company_id", tenant.companyId)
    .maybeSingle();
  if (error) throw error;
  return (data as MissedCallRow | null) ?? null;
}

/** UPDATE … WHERE <column> IS NULL → did WE set it? */
async function claimColumn(
  admin: AdminClient,
  rowId: string,
  column: "owner_alerted_at" | "ai_followup_at" | "ai_urgent_alerted_at",
  at: Date,
): Promise<boolean> {
  const { data, error } = await admin
    .from("missed_calls")
    .update({ [column]: at.toISOString() })
    .eq("id", rowId)
    .is(column, null)
    .select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

type CompanyForPostCall = Pick<
  Tables<"companies">,
  "id" | "name" | "owner_email" | "owner_phone_e164" | "quote_public_base_url" | "online_booking_settings"
>;

async function loadCompany(admin: AdminClient, tenant: { organizationId: string; companyId: string }): Promise<CompanyForPostCall | null> {
  const { data, error } = await admin
    .from("companies")
    .select("id, name, owner_email, owner_phone_e164, quote_public_base_url, online_booking_settings")
    .eq("organization_id", tenant.organizationId)
    .eq("id", tenant.companyId)
    .maybeSingle();
  if (error) throw error;
  return (data as CompanyForPostCall | null) ?? null;
}

function bookingUrlFor(company: CompanyForPostCall): string | null {
  const settings = rec(company.online_booking_settings);
  return settings.enabled === false ? null : bookingPageUrl(company);
}

type ContactRow = ConsentContact & { id: string; phone: string | null; first_name: string | null };

async function loadContact(admin: AdminClient, organizationId: string, contactId: string | null): Promise<ContactRow | null> {
  if (!contactId) return null;
  const { data } = await admin
    .from("contacts")
    .select("id, phone, first_name, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  return (data as ContactRow | null) ?? null;
}

/** Did anything already text this caller since the hand-off (e.g. the receptionist sent a quote link)? */
async function textedSince(admin: AdminClient, organizationId: string, contactId: string, since: string): Promise<boolean> {
  const { data, error } = await admin
    .from("message_log")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("channel", "sms")
    .eq("direction", "outbound")
    .gte("created_at", since)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

/** Merge what the call collected into the contact's SMS conversation (never overwrites the AI's own keys). */
export async function seedConversation(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; contactId: string; details: AnswerDetails; callId: string | null; at: Date; followUpText: string | null },
): Promise<void> {
  const { data, error } = await admin
    .from("sms_conversations")
    .select("id, collected, summary")
    .eq("organization_id", input.organizationId)
    .eq("company_id", input.companyId)
    .eq("contact_id", input.contactId)
    .maybeSingle();
  if (error) throw error;
  const existing = data as Pick<Tables<"sms_conversations">, "id" | "collected" | "summary"> | null;
  const d = input.details;
  const fromCall: Record<string, unknown> = {
    ...(d.name ? { name: d.name } : {}),
    ...(d.job ? { job: d.job } : {}),
    ...(d.address ? { address: d.address } : {}),
    ...(d.callbackNumber ? { callback_number: d.callbackNumber } : {}),
    urgency: d.urgency,
    ...(d.wantsCallback ? { callback_requested: true } : {}),
    ...(d.callbackTime ? { callback_time: d.callbackTime } : {}),
    source: "phone_call",
    last_call_id: input.callId,
    last_call_at: input.at.toISOString(),
    call_disclosed_ai: true,
  };
  const collected = { ...fromCall, ...rec(existing?.collected) };
  // Call facts are fresher than the call metadata we stored before — refresh those keys.
  for (const key of ["last_call_id", "last_call_at", "urgency", "call_disclosed_ai"]) collected[key] = fromCall[key];
  const dateLabel = input.at.toISOString().slice(0, 10);
  const line = `Phone call ${dateLabel} (AI answered): ${d.summary ?? d.job ?? "caller left a message"}${input.followUpText ? ` We texted: "${input.followUpText}"` : ""}`;
  const summary = existing?.summary ? `${existing.summary}\n${line}`.slice(-2000) : line;
  if (existing) {
    const { error: updateError } = await admin
      .from("sms_conversations")
      .update({ collected: collected as Json, summary })
      .eq("id", existing.id);
    if (updateError) throw updateError;
    return;
  }
  const { error: insertError } = await admin.from("sms_conversations").upsert(
    {
      organization_id: input.organizationId,
      company_id: input.companyId,
      contact_id: input.contactId,
      state: "ai",
      collected: collected as Json,
      summary,
    },
    { onConflict: "company_id,contact_id", ignoreDuplicates: true },
  );
  if (insertError) throw insertError;
}

export interface AnsweredCallOutcome {
  status: "handled" | "released_earlier" | "no_row" | "no_company";
  ownerAlerted: boolean;
  followUp: "sent" | "skipped" | "failed" | "not_ours" | "already_done";
  conversationSeeded: boolean;
}

/** Below this the caller barely got past the greeting — treat as "couldn't finish". */
const MIN_MESSAGE_MS = 15_000;

export async function handleAnsweredCall(
  admin: AdminClient,
  input: { tenant: VerifiedAnswerTenant; fields: RetellCallFields; leadId: string | null; contactId: string | null },
  deps: PostCallDeps = defaultPostCallDeps,
): Promise<AnsweredCallOutcome> {
  const { tenant, fields } = input;
  const now = deps.now();
  const row = await loadRow(admin, tenant);
  if (!row) {
    console.error(`[voice-ai] no missed_calls row for AI call ${tenant.callSid} — post-call skipped.`);
    return { status: "no_row", ownerAlerted: false, followUp: "skipped", conversationSeeded: false };
  }
  const company = await loadCompany(admin, tenant);
  if (!company) return { status: "no_company", ownerAlerted: false, followUp: "skipped", conversationSeeded: false };
  const context: TenantServiceContext = { organizationId: tenant.organizationId, actorProfileId: null, supabase: admin };

  // (1) Link + mark handled. Only an 'ai_pending' row moves to 'ai_handled'; a row the
  //     watchdog / failed leg already released keeps its status (its text-back went out).
  const contactId = input.contactId ?? row.contact_id;
  const patch: Partial<MissedCallRow> = {};
  if (!row.contact_id && contactId) patch.contact_id = contactId;
  if (!row.lead_id && input.leadId) patch.lead_id = input.leadId;
  if (fields.callId && !row.ai_retell_call_id) patch.ai_retell_call_id = fields.callId;
  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from("missed_calls").update(patch).eq("id", row.id);
    if (error) throw error;
  }
  if (row.text_back_status === "ai_pending") {
    const { error } = await admin
      .from("missed_calls")
      .update({ text_back_status: "ai_handled" })
      .eq("id", row.id)
      .eq("text_back_status", "ai_pending");
    if (error) throw error;
  }
  const { data: fresh } = await admin.from("missed_calls").select("text_back_status").eq("id", row.id).maybeSingle();
  const ours = ((fresh as { text_back_status: string } | null)?.text_back_status ?? row.text_back_status) === "ai_handled";

  const details = readAnswerDetails(fields);
  const callerNumber = toE164(fields.fromNumber) ?? row.from_number;
  const tookMessage = (fields.durationMs ?? 0) >= MIN_MESSAGE_MS || Boolean(details.job || details.name);
  const bookingUrl = bookingUrlFor(company);

  // (2) The follow-up text (before the owner alert, so the alert can say it went).
  let followUp: AnsweredCallOutcome["followUp"] = "skipped";
  let followUpText: string | null = null;
  const contact = await loadContact(admin, tenant.organizationId, contactId);
  if (!ours) {
    followUp = "not_ours";
  } else if (row.ai_followup_at) {
    followUp = "already_done";
  } else if (!callerNumber || isAnonymousCaller(callerNumber) || details.doNotText || contact?.sms_opt_out_at) {
    followUp = "skipped";
  } else if (contactId && row.ai_handoff_at && (await textedSince(admin, tenant.organizationId, contactId, row.ai_handoff_at))) {
    followUp = "skipped"; // the receptionist already texted them (quote / deposit link)
  } else if (await claimColumn(admin, row.id, "ai_followup_at", now)) {
    followUpText = buildFollowUpText({ companyName: company.name, details, bookingUrl, tookMessage });
    try {
      const result = await deps.send({
        context,
        channel: "sms",
        to: callerNumber,
        body: followUpText,
        companyId: tenant.companyId,
        contactId,
        consentContact: contact,
        sentBy: VOICE_AGENT_SENDER,
      });
      followUp = result.status === "sent" ? "sent" : result.status === "blocked" ? "skipped" : "failed";
      if (result.status !== "sent") followUpText = null;
    } catch (err) {
      // Keep the claim: one attempt only — a retry must never double-text the caller.
      console.error("[voice-ai] follow-up text failed:", err instanceof Error ? err.message : err);
      followUp = "failed";
      followUpText = null;
    }
  } else {
    followUp = "already_done";
  }

  // (3) The owner alert — once per call.
  let ownerAlerted = false;
  if (await claimColumn(admin, row.id, "owner_alerted_at", now)) {
    const owner = await resolveOwnerContacts(context, company);
    const alert = buildOwnerAlert({ companyName: company.name, details, callerNumber, durationMs: fields.durationMs, followUp });
    try {
      if (owner.phone) {
        const r = await deps.send({ context, channel: "sms", to: owner.phone, body: alert.sms, companyId: tenant.companyId, contactId: null, consentContact: null });
        ownerAlerted = r.status === "sent";
      }
      if (owner.email && (details.urgency !== "normal" || !ownerAlerted)) {
        const r = await deps.send({
          context,
          channel: "email",
          to: owner.email,
          subject: alert.subject,
          body: alert.email,
          companyId: tenant.companyId,
          contactId: null,
          consentContact: null,
        });
        ownerAlerted = ownerAlerted || r.status === "sent";
      }
    } catch (err) {
      console.error("[voice-ai] owner alert failed:", err instanceof Error ? err.message : err);
    }
  }

  // (4) Seed the texting AI's conversation.
  let conversationSeeded = false;
  if (contactId) {
    try {
      await seedConversation(admin, {
        organizationId: tenant.organizationId,
        companyId: tenant.companyId,
        contactId,
        details,
        callId: fields.callId,
        at: now,
        followUpText,
      });
      conversationSeeded = true;
    } catch (err) {
      console.error("[voice-ai] conversation seed failed:", err instanceof Error ? err.message : err);
    }
  }

  return { status: ours ? "handled" : "released_earlier", ownerAlerted, followUp, conversationSeeded };
}

// ── Mid-call: "this is an emergency" → alert the owner NOW ─────────────────────────

export interface UrgentAlertArgs {
  what?: unknown;
  address?: unknown;
  caller_name?: unknown;
  callback_number?: unknown;
}

export interface UrgentAlertResult {
  ok: boolean;
  say: string;
}

const SAY_ALERTED = "I've just alerted the team — someone will call you back as soon as possible.";
const SAY_ALERT_FALLBACK = "I'm flagging this as urgent for the team right now. Stay safe, and if anyone is in danger, please hang up and call 9-1-1.";

export async function runUrgentAlert(
  admin: AdminClient,
  input: { tenant: VerifiedAnswerTenant; args: UrgentAlertArgs; fromNumber: string | null },
  deps: PostCallDeps = defaultPostCallDeps,
): Promise<UrgentAlertResult> {
  const row = await loadRow(admin, input.tenant);
  if (!row) return { ok: false, say: SAY_ALERT_FALLBACK };
  if (row.ai_urgent_alerted_at) return { ok: true, say: SAY_ALERTED };
  const company = await loadCompany(admin, input.tenant);
  if (!company) return { ok: false, say: SAY_ALERT_FALLBACK };
  if (!(await claimColumn(admin, row.id, "ai_urgent_alerted_at", deps.now()))) return { ok: true, say: SAY_ALERTED };

  const context: TenantServiceContext = { organizationId: input.tenant.organizationId, actorProfileId: null, supabase: admin };
  const owner = await resolveOwnerContacts(context, company);
  const caller = toE164(input.fromNumber) ?? row.from_number;
  const name = text(input.args.caller_name, 60);
  const what = text(input.args.what, 160) ?? "an urgent problem";
  const where = text(input.args.address, 120);
  const callback = text(input.args.callback_number, 30);
  const body =
    `🚨 URGENT call right now for ${company.name}: ${name ? `${name} · ` : ""}${caller ? prettyPhone(caller) : "private number"} — ${what}` +
    `${where ? ` at ${where}` : ""}.${callback && normalizePhoneLast10(callback) !== normalizePhoneLast10(caller) ? ` Callback: ${prettyPhone(callback)}.` : ""} Call them back now.`;
  let sent = false;
  try {
    if (owner.phone) {
      sent = (await deps.send({ context, channel: "sms", to: owner.phone, body, companyId: company.id, contactId: null, consentContact: null })).status === "sent";
    }
    if (owner.email) {
      const r = await deps.send({
        context,
        channel: "email",
        to: owner.email,
        subject: `🚨 Urgent call for ${company.name}`,
        body,
        companyId: company.id,
        contactId: null,
        consentContact: null,
      });
      sent = sent || r.status === "sent";
    }
  } catch (err) {
    console.error("[voice-ai] urgent alert failed:", err instanceof Error ? err.message : err);
  }
  if (!sent) {
    // Release the claim so the post-call alert (urgent-flagged) is the backstop, and say so honestly.
    await admin.from("missed_calls").update({ ai_urgent_alerted_at: null }).eq("id", row.id);
    return { ok: false, say: SAY_ALERT_FALLBACK };
  }
  return { ok: true, say: SAY_ALERTED };
}
