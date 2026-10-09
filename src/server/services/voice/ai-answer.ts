// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4b (continued — missed-call catcher → AI answering): runs from the
// Twilio voice webhook (no session) with the service-role client. The TENANT is the one
// resolveCatcherTenant found from the CALLED catcher number; nothing the caller says or
// sends can change it. The tenant is carried to Retell in the call's metadata together with
// an HMAC token over (org, company, CallSid), and every Retell callback that acts on a
// tenant re-verifies that token (verifyAnswerToken) before trusting it.
// docs/front-desk-ai.md → "## Phone answering".
// ─────────────────────────────────────────────────────────────────────────────
/**
 * "AI answers when you can't": hand a forwarded catcher call to a Retell agent.
 *
 * Approach (docs/front-desk-ai.md → "## Phone answering" → "How the call reaches the AI"):
 * Retell's custom-telephony "dial to SIP URI" method — POST /v2/register-phone-call returns a
 * call_id, and Twilio <Dial><Sip>sip:{call_id}@sip.retellai.com</Sip></Dial> connects the
 * caller. No Retell number is bought per company; our Twilio catcher stays the entry point,
 * so when Retell is down/slow (registration fails, the SIP leg doesn't answer) the caller
 * falls straight back to the existing greeting + voicemail + text-back.
 */
import crypto from "node:crypto";

import type { Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { hoursToText } from "@/server/services/onboarding-provision";
import { getPack } from "@/server/services/packs";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import { toE164 } from "@/server/services/retell/payload";
import { bookingPageUrl } from "@/server/services/scheduling/urls";
import { businessTypeSuffix } from "@/server/services/voice/message-agent";
import { readCallAnsweringSettings, type CallAnsweringSettings } from "@/server/services/voice/answering-settings";
import { aiCallTimeLimitSeconds, loadMinuteAllowance, type MinuteAllowance } from "@/server/services/voice/minutes";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** What we stamp in Retell call metadata so the post-call webhook knows where it came from. */
export const AI_ANSWER_SOURCE = "catcher_ai";
/** inbound_webhook_jobs provider for AI-answering housekeeping (watchdog, owner notices). */
export const VOICE_AI_JOB_PROVIDER = "twilio_voice_ai";

const RETELL_API = "https://api.retellai.com";
const DEFAULT_SIP_DOMAIN = "sip.retellai.com";
const DEFAULT_RING_TIMEOUT_SECONDS = 12;
const DEFAULT_REGISTER_TIMEOUT_MS = 3000;
const DEFAULT_WATCHDOG_MINUTES = 30;

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(env(name) ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export interface AiAnswerConfig {
  /** RETELL_INTAKE_ENABLED=1 — the same kill switch as every other Retell intake path. */
  enabled: boolean;
  apiKey: string | null;
  /** RETELL_MESSAGE_AGENT_ID — the ONE shared message-taking agent (per-call dynamic variables). */
  messageAgentId: string | null;
  /** HMAC key for the tenant token in call metadata. */
  tokenSecret: string | null;
  sipDomain: string;
  ringTimeoutSeconds: number;
  registerTimeoutMs: number;
  watchdogMinutes: number;
}

export function getAiAnswerConfig(): AiAnswerConfig {
  return {
    enabled: process.env.RETELL_INTAKE_ENABLED === "1",
    apiKey: env("RETELL_API_KEY"),
    messageAgentId: env("RETELL_MESSAGE_AGENT_ID"),
    tokenSecret: env("VOICE_AI_TOKEN_SECRET") ?? env("RETELL_FUNCTION_SECRET"),
    sipDomain: env("RETELL_SIP_DOMAIN") ?? DEFAULT_SIP_DOMAIN,
    ringTimeoutSeconds: intEnv("AI_ANSWER_RING_TIMEOUT_SECONDS", DEFAULT_RING_TIMEOUT_SECONDS, 5, 30),
    registerTimeoutMs: intEnv("AI_ANSWER_REGISTER_TIMEOUT_MS", DEFAULT_REGISTER_TIMEOUT_MS, 500, 8000),
    watchdogMinutes: intEnv("AI_ANSWER_WATCHDOG_MINUTES", DEFAULT_WATCHDOG_MINUTES, 20, 240),
  };
}

// ── Tenant token (HMAC over the tenant WE resolved) ────────────────────────────

export interface AnswerTokenClaims {
  organizationId: string;
  companyId: string;
  /** The Twilio CallSid of the forwarded call (links the missed_calls row). */
  callSid: string;
}

function tokenPayload(claims: AnswerTokenClaims): string {
  return `${AI_ANSWER_SOURCE}|${claims.organizationId}|${claims.companyId}|${claims.callSid}`;
}

export function signAnswerToken(claims: AnswerTokenClaims, secret: string): string {
  return crypto.createHmac("sha256", secret).update(tokenPayload(claims)).digest("base64url");
}

/** Timing-safe check of a token against the claims it says it covers. */
export function verifyAnswerToken(claims: AnswerTokenClaims, token: unknown, secret: string | null): boolean {
  if (!secret || typeof token !== "string" || !token) return false;
  const expected = Buffer.from(signAnswerToken(claims, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** The metadata object we hand Retell (echoed back on every webhook / tool call for this call). */
export interface AnswerMetadata {
  source: typeof AI_ANSWER_SOURCE;
  organization_id: string;
  company_id: string;
  twilio_call_sid: string;
  agent_kind: AgentKind;
  token: string;
}

export function buildAnswerMetadata(claims: AnswerTokenClaims, agentKind: AgentKind, secret: string): AnswerMetadata {
  return {
    source: AI_ANSWER_SOURCE,
    organization_id: claims.organizationId,
    company_id: claims.companyId,
    twilio_call_sid: claims.callSid,
    agent_kind: agentKind,
    token: signAnswerToken(claims, secret),
  };
}

export interface VerifiedAnswerTenant extends AnswerTokenClaims {
  agentKind: AgentKind;
}

/**
 * Read + verify the AI-answer metadata on a Retell call. Returns:
 *   • null           — not an AI-answered catcher call (no `source: catcher_ai`);
 *   • { valid:false} — it CLAIMS to be one but the token doesn't verify (never trust it);
 *   • the tenant     — verified.
 */
export function readAnswerMetadata(
  metadata: unknown,
  secret: string | null = getAiAnswerConfig().tokenSecret,
): VerifiedAnswerTenant | { valid: false } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (m.source !== AI_ANSWER_SOURCE) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const organizationId = str(m.organization_id);
  const companyId = str(m.company_id);
  const callSid = str(m.twilio_call_sid);
  if (!organizationId || !companyId || !callSid) return { valid: false };
  const claims = { organizationId, companyId, callSid };
  if (!verifyAnswerToken(claims, m.token, secret)) return { valid: false };
  return { ...claims, agentKind: m.agent_kind === "receptionist" ? "receptionist" : "message" };
}

export function isVerifiedAnswerTenant(value: ReturnType<typeof readAnswerMetadata>): value is VerifiedAnswerTenant {
  return Boolean(value && !("valid" in value));
}

// ── Retell registration ────────────────────────────────────────────────────────

export interface RegisterCallInput {
  agentId: string;
  fromNumber: string | null;
  toNumber: string | null;
  metadata: AnswerMetadata;
  dynamicVariables: Record<string, string>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** POST /v2/register-phone-call → the call_id to dial (sip:{call_id}@sip.retellai.com). */
export async function registerRetellCall(
  input: RegisterCallInput,
  config: Pick<AiAnswerConfig, "apiKey" | "registerTimeoutMs">,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  if (!config.apiKey) throw new Error("RETELL_API_KEY is not set.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.registerTimeoutMs);
  try {
    const response = await fetchImpl(`${RETELL_API}/v2/register-phone-call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: input.agentId,
        direction: "inbound",
        ...(input.fromNumber ? { from_number: input.fromNumber } : {}),
        ...(input.toNumber ? { to_number: input.toNumber } : {}),
        metadata: input.metadata,
        retell_llm_dynamic_variables: input.dynamicVariables,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Retell register-phone-call failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const json = (await response.json().catch(() => ({}))) as { call_id?: unknown };
    if (typeof json.call_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(json.call_id)) {
      throw new Error("Retell register-phone-call returned no usable call_id.");
    }
    return json.call_id;
  } finally {
    clearTimeout(timer);
  }
}

export function retellSipUri(callId: string, sipDomain: string = DEFAULT_SIP_DOMAIN): string {
  return `sip:${callId}@${sipDomain}`;
}

// ── What the AI is told about the business (per-call dynamic variables) ──────────

export type AgentKind = "message" | "receptionist";

type CompanyFacts = Pick<
  Tables<"companies">,
  "id" | "name" | "hours" | "service_area" | "quote_public_base_url" | "industry_pack" | "timezone" | "ai_settings" | "online_booking_settings"
>;

function bookingEnabled(company: CompanyFacts): boolean {
  const settings = company.online_booking_settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return true;
  return (settings as Record<string, unknown>).enabled !== false;
}

/** All values are strings (Retell's rule); an empty string removes the placeholder. Pure. */
export function buildAnswerDynamicVariables(company: CompanyFacts, companyName: string | null): Record<string, string> {
  const name = (companyName ?? company.name ?? "").trim() || "the business";
  const applied = parseAppliedIndustryPack(company.industry_pack);
  const pack = applied ? getPack(applied.id) : null;
  const bookingLink = bookingEnabled(company) ? bookingPageUrl(company) : "";
  return {
    company_name: name,
    business_type: pack?.name ?? "",
    business_type_suffix: businessTypeSuffix(pack?.name ?? ""),
    hours_text: hoursToText(company.hours) ?? "",
    service_area: company.service_area?.trim() ?? "",
    booking_link: bookingLink,
    has_booking_link: bookingLink ? "yes" : "no",
  };
}

// ── The decision ─────────────────────────────────────────────────────────────

export type VoicemailReason =
  | "mode_voicemail"
  | "not_configured"
  | "no_agent"
  | "billing"
  | "minutes_exhausted"
  | "error";

export type AiAnswerDecision =
  | {
      kind: "ai";
      agentId: string;
      agentKind: AgentKind;
      allowance: MinuteAllowance;
      timeLimitSeconds: number;
      dynamicVariables: Record<string, string>;
      timeZone: string | null;
    }
  | {
      kind: "voicemail";
      reason: VoicemailReason;
      allowance?: MinuteAllowance;
      timeZone?: string | null;
    };

export interface DecideInput {
  organizationId: string;
  companyId: string;
  companyName: string | null;
}

export interface DecideDeps {
  config?: AiAnswerConfig;
  now?: Date;
  /** Billing health (orgCan workflows) — injectable for tests. */
  billingHealthy?: (admin: AdminClient, organizationId: string) => Promise<boolean>;
}

async function defaultBillingHealthy(admin: AdminClient, organizationId: string): Promise<boolean> {
  const { orgCan } = await import("@/server/services/billing/gating");
  // `workflows` is on every plan that answers calls (operate / front_desk / internal); orgCan
  // is false for an unhealthy (lapsed) subscription — no paid AI minutes then.
  return orgCan(admin as unknown as Parameters<typeof orgCan>[0], organizationId, "workflows");
}

/** The company's own Front Desk receptionist agent, if it has one (voice_numbers, provider retell). */
async function receptionistAgentId(admin: AdminClient, organizationId: string, companyId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("voice_numbers")
    .select("provider_agent_id")
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .eq("provider", "retell")
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const id = (data as { provider_agent_id: string | null } | null)?.provider_agent_id ?? null;
  return id?.trim() || null;
}

export interface CompanyAnsweringState {
  company: CompanyFacts;
  org: Pick<Tables<"organizations">, "plan" | "platform_brand" | "crankleads_tier">;
  settings: CallAnsweringSettings;
}

export async function loadAnsweringState(admin: AdminClient, organizationId: string, companyId: string): Promise<CompanyAnsweringState | null> {
  const [{ data: company, error: companyError }, { data: org, error: orgError }] = await Promise.all([
    admin
      .from("companies")
      .select("id, name, hours, service_area, quote_public_base_url, industry_pack, timezone, ai_settings, online_booking_settings")
      .eq("organization_id", organizationId)
      .eq("id", companyId)
      .maybeSingle(),
    admin.from("organizations").select("plan, platform_brand, crankleads_tier").eq("id", organizationId).maybeSingle(),
  ]);
  if (companyError) throw companyError;
  if (orgError) throw orgError;
  if (!company || !org) return null;
  const orgRow = org as CompanyAnsweringState["org"];
  const companyRow = company as CompanyFacts;
  return {
    company: companyRow,
    org: orgRow,
    settings: readCallAnsweringSettings(companyRow.ai_settings, { crankleads: orgRow.platform_brand === "crankleads" }),
  };
}

/**
 * Should this forwarded call go to the AI? Reads only OUR data (the tenant from the called
 * number). Order: settings mode → deployment configured → billing healthy → which agent →
 * minutes left. Any error → voicemail (the existing behaviour), never a dropped call.
 */
export async function decideCallAnswering(admin: AdminClient, input: DecideInput, deps: DecideDeps = {}): Promise<AiAnswerDecision> {
  const config = deps.config ?? getAiAnswerConfig();
  const now = deps.now ?? new Date();
  try {
    const state = await loadAnsweringState(admin, input.organizationId, input.companyId);
    if (!state) return { kind: "voicemail", reason: "error" };
    const timeZone = state.company.timezone ?? null;
    if (state.settings.mode !== "ai") return { kind: "voicemail", reason: "mode_voicemail", timeZone };
    if (!config.enabled || !config.apiKey || !config.tokenSecret) return { kind: "voicemail", reason: "not_configured", timeZone };

    if (!(await (deps.billingHealthy ?? defaultBillingHealthy)(admin, input.organizationId))) {
      return { kind: "voicemail", reason: "billing", timeZone };
    }

    const frontDesk = state.org.crankleads_tier === "front_desk" || state.org.plan === "front_desk";
    const ownAgent = frontDesk ? await receptionistAgentId(admin, input.organizationId, input.companyId) : null;
    const agentId = ownAgent ?? config.messageAgentId;
    if (!agentId) return { kind: "voicemail", reason: "no_agent", timeZone };

    const allowance = await loadMinuteAllowance(
      admin,
      {
        organizationId: input.organizationId,
        companyId: input.companyId,
        tier: state.org.crankleads_tier,
        plan: state.org.plan,
        includedMinutes: state.settings.includedMinutes,
      },
      now,
    );
    if (allowance.remainingMinutes !== null && allowance.remainingMinutes <= 0) {
      return { kind: "voicemail", reason: "minutes_exhausted", allowance, timeZone };
    }

    return {
      kind: "ai",
      agentId,
      agentKind: ownAgent ? "receptionist" : "message",
      allowance,
      timeLimitSeconds: aiCallTimeLimitSeconds(allowance.remainingMinutes),
      dynamicVariables: buildAnswerDynamicVariables(state.company, input.companyName),
      timeZone,
    };
  } catch (err) {
    console.error("[voice-ai] answering decision failed (voicemail):", err instanceof Error ? err.message : err);
    return { kind: "voicemail", reason: "error" };
  }
}

// ── The per-call claim on missed_calls ───────────────────────────────────────────

export interface ClaimInput {
  organizationId: string;
  companyId: string;
  callSid: string;
  from: string | null;
  to: string;
  forwardedFrom: string | null;
  callerName: string | null;
  rawPayload: Record<string, string>;
}

/**
 * Create the call's missed_calls row in 'ai_pending' BEFORE the worker does. Returns false when
 * a row already exists (the worker got there first, or a redelivery) — then the caller does NOT
 * hand off, so a text-back that already went out is never followed by an AI call as well.
 */
export async function claimAiPending(admin: AdminClient, input: ClaimInput, now: Date = new Date()): Promise<boolean> {
  const fromE164 = toE164(input.from);
  const { data, error } = await admin
    .from("missed_calls")
    .upsert(
      {
        organization_id: input.organizationId,
        company_id: input.companyId,
        call_sid: input.callSid,
        provider: "twilio",
        from_number: fromE164 ?? input.from,
        to_number: input.to,
        forwarded_from: toE164(input.forwardedFrom) ?? input.forwardedFrom,
        caller_phone_last10: normalizePhoneLast10(input.from),
        caller_name: input.callerName,
        text_back_status: "ai_pending",
        ai_handoff_at: now.toISOString(),
        raw_payload: toJson(input.rawPayload),
      },
      { onConflict: "call_sid", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

export async function recordRetellCallId(admin: AdminClient, callSid: string, retellCallId: string): Promise<void> {
  const { error } = await admin.from("missed_calls").update({ ai_retell_call_id: retellCallId }).eq("call_sid", callSid);
  if (error) throw error;
}

/**
 * The AI leg didn't happen (registration failed, the SIP leg didn't answer, or the watchdog
 * found no post-call webhook): move the row back to 'pending' so the NORMAL missed-call path
 * runs — lead, call.missed, the generic text-back. Atomic: only an 'ai_pending' row moves, so
 * this never fires after the AI already handled the call. Returns whether it moved.
 */
export async function releaseAiPending(admin: AdminClient, callSid: string, now: Date = new Date()): Promise<boolean> {
  const { data, error } = await admin
    .from("missed_calls")
    .update({ text_back_status: "pending", ai_released_at: now.toISOString() })
    .eq("call_sid", callSid)
    .eq("text_back_status", "ai_pending")
    .select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

/** Re-run the normal catcher worker for a released call (durable: same queue, own key). */
export async function enqueueRelease(admin: AdminClient, callSid: string, payload: Record<string, string>): Promise<void> {
  const { VOICE_JOB_PROVIDER } = await import("@/server/services/twilio/missed-call");
  const { error } = await admin.from("inbound_webhook_jobs").upsert(
    {
      provider: VOICE_JOB_PROVIDER,
      external_id: `release:${callSid}`,
      payload: toJson(payload),
      status: "pending",
      max_attempts: 5,
    },
    { onConflict: "provider,external_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

// ── Owner notices that wait for civil hours ───────────────────────────────────────

/** 08:00–21:00 in the company's zone, as the brief requires for non-urgent owner pings. */
export function nextCivilTime(now: Date, timeZone: string | null, startHour = 8, endHour = 21): Date {
  const zone = timeZone || "America/Toronto";
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour: "numeric", hourCycle: "h23" }).format(now),
  );
  if (hour >= startHour && hour < endHour) return now;
  const hoursUntil = hour >= endHour ? 24 - hour + startHour : startHour - hour;
  const minutes = Number(new Intl.DateTimeFormat("en-CA", { timeZone: zone, minute: "numeric" }).format(now));
  return new Date(now.getTime() + (hoursUntil * 60 - minutes) * 60_000);
}

/** Queue the once-a-month "your AI minutes are used up" owner notice (deduped by the queue key). */
export async function enqueueMinutesNotice(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; month: string; timeZone: string | null },
  now: Date = new Date(),
): Promise<void> {
  const { error } = await admin.from("inbound_webhook_jobs").upsert(
    {
      provider: VOICE_AI_JOB_PROVIDER,
      external_id: `minutes:${input.companyId}:${input.month}`,
      payload: toJson({ kind: "minutes_notice", organizationId: input.organizationId, companyId: input.companyId, month: input.month }),
      organization_id: input.organizationId,
      company_id: input.companyId,
      status: "pending",
      max_attempts: 5,
      run_at: nextCivilTime(now, input.timeZone).toISOString(),
    },
    { onConflict: "provider,external_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

/** Queue the watchdog that releases a hand-off whose post-call webhook never came. */
export async function scheduleAiWatchdog(admin: AdminClient, callSid: string, now: Date = new Date()): Promise<void> {
  const minutes = getAiAnswerConfig().watchdogMinutes;
  const { error } = await admin.from("inbound_webhook_jobs").upsert(
    {
      provider: VOICE_AI_JOB_PROVIDER,
      external_id: `watchdog:${callSid}`,
      payload: toJson({ kind: "watchdog", CallSid: callSid }),
      status: "pending",
      max_attempts: 5,
      run_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
    },
    { onConflict: "provider,external_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

// ── The route's one call ───────────────────────────────────────────────────────

export type StartAiAnswerResult =
  | { kind: "ai"; sipUri: string; retellCallId: string; timeLimitSeconds: number; ringTimeoutSeconds: number }
  | { kind: "voicemail"; reason: VoicemailReason | "already_processed" | "register_failed" };

export interface StartAiAnswerInput {
  tenant: { organizationId: string; companyId: string; companyName: string | null; phoneE164: string };
  params: Record<string, string>;
}

export interface StartAiAnswerDeps extends DecideDeps {
  fetchImpl?: FetchLike;
}

/**
 * Decide → claim the call row → register with Retell → the SIP URI to dial. Every failure
 * lands on "voicemail" (the existing greeting + <Record>), with the row released so the normal
 * text-back still goes out. Never throws.
 */
export async function startAiAnswer(admin: AdminClient, input: StartAiAnswerInput, deps: StartAiAnswerDeps = {}): Promise<StartAiAnswerResult> {
  const config = deps.config ?? getAiAnswerConfig();
  const now = deps.now ?? new Date();
  const { tenant, params } = input;
  const callSid = params.CallSid;
  const decision = await decideCallAnswering(
    admin,
    { organizationId: tenant.organizationId, companyId: tenant.companyId, companyName: tenant.companyName },
    { ...deps, config, now },
  );

  if (decision.kind === "voicemail") {
    if (decision.reason === "minutes_exhausted" && decision.allowance) {
      try {
        await enqueueMinutesNotice(
          admin,
          { organizationId: tenant.organizationId, companyId: tenant.companyId, month: decision.allowance.month, timeZone: decision.timeZone ?? null },
          now,
        );
      } catch (err) {
        console.error("[voice-ai] could not queue the minutes notice:", err instanceof Error ? err.message : err);
      }
    }
    return { kind: "voicemail", reason: decision.reason };
  }

  let claimed = false;
  try {
    claimed = await claimAiPending(
      admin,
      {
        organizationId: tenant.organizationId,
        companyId: tenant.companyId,
        callSid,
        from: params.From ?? null,
        to: tenant.phoneE164,
        forwardedFrom: params.ForwardedFrom ?? null,
        callerName: params.CallerName ?? null,
        rawPayload: params,
      },
      now,
    );
  } catch (err) {
    console.error("[voice-ai] claim failed (voicemail):", err instanceof Error ? err.message : err);
    return { kind: "voicemail", reason: "error" };
  }
  if (!claimed) return { kind: "voicemail", reason: "already_processed" };

  try {
    const claims = { organizationId: tenant.organizationId, companyId: tenant.companyId, callSid };
    const retellCallId = await registerRetellCall(
      {
        agentId: decision.agentId,
        fromNumber: toE164(params.From ?? null),
        toNumber: tenant.phoneE164,
        metadata: buildAnswerMetadata(claims, decision.agentKind, config.tokenSecret!),
        dynamicVariables: decision.dynamicVariables,
      },
      config,
      deps.fetchImpl,
    );
    try {
      await recordRetellCallId(admin, callSid, retellCallId);
    } catch (err) {
      // The metadata carries the CallSid, so the post-call still finds the row.
      console.error("[voice-ai] could not store the Retell call id:", err instanceof Error ? err.message : err);
    }
    return {
      kind: "ai",
      sipUri: retellSipUri(retellCallId, config.sipDomain),
      retellCallId,
      timeLimitSeconds: decision.timeLimitSeconds,
      ringTimeoutSeconds: config.ringTimeoutSeconds,
    };
  } catch (err) {
    console.error("[voice-ai] Retell registration failed (voicemail):", err instanceof Error ? err.message : err);
    await releaseForFallback(admin, callSid, params, now);
    return { kind: "voicemail", reason: "register_failed" };
  }
}

/** The original inbound webhook params stored on the claimed row (for a release job). */
export async function storedCallParams(admin: AdminClient, callSid: string): Promise<Record<string, string> | null> {
  const { data, error } = await admin.from("missed_calls").select("raw_payload").eq("call_sid", callSid).maybeSingle();
  if (error) throw error;
  const raw = (data as { raw_payload: unknown } | null)?.raw_payload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** Release + re-queue the normal missed-call path. Best-effort, never throws. */
export async function releaseForFallback(admin: AdminClient, callSid: string, params: Record<string, string>, now: Date = new Date()): Promise<void> {
  try {
    if (await releaseAiPending(admin, callSid, now)) await enqueueRelease(admin, callSid, params);
  } catch (err) {
    console.error("[voice-ai] release after a failed hand-off failed:", err instanceof Error ? err.message : err);
  }
}
