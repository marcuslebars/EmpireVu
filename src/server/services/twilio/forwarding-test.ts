// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #4c (missed-call catcher — forwarding verification;
// docs/missed-call-catcher.md → "Forwarding verification"): this module writes
// forwarding_tests and the voice_numbers verification columns with the Supabase
// service-role (RLS-bypassing) client. forwarding_tests has NO member write policy on
// purpose: a test places a billed phone call, so it is only ever created through this
// rate-limited path. The tenant is never taken from a request body:
//   • owner-triggered tests: the org comes from the authenticated route's
//     requireOrganizationContext; the company is checked against it
//     (assertCompanyInOrganization) and the catcher number + business line are READ WITH
//     THE CALLER'S RLS CLIENT before anything is written; the number we call is the
//     company's own stored business number, never a request parameter;
//   • Twilio callbacks: signature-verified routes; the test row is found by the testId we
//     put in the callback URL ourselves (covered by X-Twilio-Signature) and is processed in
//     the inbound-webhook worker;
//   • the forwarded leg: decided ONCE in the signature-verified voice webhook, and only for
//     a call whose From is one of OUR numbers (the test caller ID) reaching the test's own
//     catcher number in the window; the test id is stamped into the durable job payload and
//     the worker (missed-call.ts) only accepts it for a test of the tenant resolved from the
//     CALLED number. A call without the flag is always a normal missed call;
//   • scheduled retests: the worker's scheduler pass (cross-tenant by design), each test
//     scoped to the voice_numbers row's own organization_id + company_id; cancelled orgs are
//     skipped.
// Listed in docs/EMPIREVU_RUNBOOK.md → "Service-role (sanctioned) surfaces".
// ─────────────────────────────────────────────────────────────────────────────
import type { Json, Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import { prettyPhone } from "@/lib/carrier-forwarding";
import { TooManyRequestsError, ValidationError } from "@/server/organizations/context";
import { getOnboardingProgress, recordOnboardingEvent, upsertOnboardingStep } from "@/server/services/onboarding";
import { toE164 } from "@/server/services/retell/payload";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { createTwilioCallsClient, TwilioApiError, type TwilioCallsClient } from "@/server/services/twilio/calls";
import {
  buildForwardingResultMessage,
  businessLineProblem,
  checkOwnerTestRateLimit,
  isTerminalCallStatus,
  matchForwardingTest,
  MAX_SCHEDULED_TESTS_PER_PASS,
  nextTestStatus,
  outcomeFromCall,
  phoneStepLink,
  retestDecision,
  shouldNotifyOwner,
  TEST_DETECT_WINDOW_MS,
  TEST_FINALIZE_GRACE_MS,
  TEST_RING_TIMEOUT_SECONDS,
  TEST_STALE_MS,
  verificationPatch,
  withinCallingHours,
  type ForwardingTestOutcome,
  type ForwardingTestStatus,
  type ForwardingTestTrigger,
  type InboundLeg,
  type RetestCandidate,
  type TestCandidate,
} from "@/server/services/twilio/forwarding-test-logic";
import {
  FORWARDING_TEST_CALLBACK_PATH,
  forwardingTestCallerId,
  forwardingTestVerifierNumber,
  sayVoice,
  twilioWebhookBaseUrl,
} from "@/server/services/twilio/voice-config";
import { buildForwardingTestAnsweredTwiml } from "@/server/services/twilio/voice-twiml";
import { deliverMessage, resolveOwnerContacts } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { appBaseUrlFor, loadOrganizationBrand } from "@/server/services/platform-brand";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type ForwardingTestRow = Tables<"forwarding_tests">;
type VoiceNumberRow = Tables<"voice_numbers">;
type CompanyFields = Pick<Tables<"companies">, "id" | "organization_id" | "name" | "timezone" | "brand_reply_phone" | "owner_phone_e164" | "owner_email">;

/** inbound_webhook_jobs provider for status / AMD callbacks and the delayed finalize. */
export const FORWARDING_TEST_JOB_PROVIDER = "twilio_forwarding_test";
/**
 * Key the voice webhook adds to a 'twilio_voice' job payload when it decided the call is the
 * forwarded leg of a forwarding test (value: forwarding_tests.id). Not a Twilio parameter —
 * the webhook strips any incoming copy before deciding. The worker trusts it and never
 * re-matches; a payload without it is always handled as a normal missed call.
 */
export const FORWARDING_TEST_LEG_KEY = "EmpireVuForwardingTestId";
const CATCHER_MODE = "missed_call_catcher";
const COMPANY_FIELDS = "id, organization_id, name, timezone, brand_reply_phone, owner_phone_e164, owner_email";

export interface ForwardingTestDeps {
  calls?: TwilioCallsClient;
  now?: () => number;
}

function twilioCreds(): { accountSid: string; authToken: string } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

function fallbackTimeZone(): string {
  return process.env.BUSINESS_TIMEZONE?.trim() || "America/Toronto";
}

/**
 * The number we test-call: the company's public business phone (companies.brand_reply_phone,
 * the number on quotes/branding), else the owner phone captured at signup / in the Business
 * step (for a CrankLeads buyer that is the phone they gave at checkout — for most small
 * trades it IS the business line). E.164 or null. Never a request parameter.
 */
export function resolveBusinessLine(company: Pick<Tables<"companies">, "brand_reply_phone" | "owner_phone_e164"> | null): string | null {
  return toE164(company?.brand_reply_phone) ?? toE164(company?.owner_phone_e164) ?? null;
}

// ── Reads (RLS context for owner calls; admin context for the worker) ────────

async function loadCatcherRow(context: TenantServiceContext, companyId: string): Promise<VoiceNumberRow | null> {
  const { data, error } = await context.supabase
    .from("voice_numbers")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .eq("provider", "twilio")
    .eq("mode", CATCHER_MODE)
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as VoiceNumberRow | null) ?? null;
}

async function loadCompany(context: TenantServiceContext, companyId: string): Promise<CompanyFields | null> {
  const { data, error } = await context.supabase
    .from("companies")
    .select(COMPANY_FIELDS)
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  return (data as CompanyFields | null) ?? null;
}

async function loadTest(admin: AdminClient, testId: string): Promise<ForwardingTestRow | null> {
  const { data, error } = await admin.from("forwarding_tests").select("*").eq("id", testId).maybeSingle();
  if (error) throw error;
  return (data as ForwardingTestRow | null) ?? null;
}

/** Is this number one of ours in ANY org (cross-org, service role)? Calling it would loop. */
async function isPlatformNumber(admin: AdminClient, phoneE164: string): Promise<boolean> {
  const { data, error } = await admin.from("voice_numbers").select("id").eq("phone_e164", phoneE164).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

// ── Placing a test ───────────────────────────────────────────────────────────

interface TestTarget {
  voiceNumber: VoiceNumberRow;
  company: CompanyFields;
  businessLine: string | null;
}

export interface ForwardingTestView {
  id: string;
  status: ForwardingTestStatus;
  trigger: ForwardingTestTrigger;
  startedAt: string;
  completedAt: string | null;
  callerId: string;
  callerIdPretty: string;
  businessLinePretty: string;
  answeredBy: string | null;
  errorMessage: string | null;
}

export function toTestView(row: ForwardingTestRow): ForwardingTestView {
  return {
    id: row.id,
    status: row.status as ForwardingTestStatus,
    trigger: row.trigger as ForwardingTestTrigger,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    callerId: row.caller_id,
    callerIdPretty: prettyPhone(row.caller_id),
    businessLinePretty: prettyPhone(row.business_line),
    answeredBy: row.outbound_answered_by,
    errorMessage: row.error_message,
  };
}

function callbackUrls(base: string, testId: string): { status: string; amd: string } {
  const path = `${base}${FORWARDING_TEST_CALLBACK_PATH}?testId=${encodeURIComponent(testId)}`;
  return { status: `${path}&event=status`, amd: `${path}&event=amd` };
}

/**
 * Place one test call (owner or scheduled). Guards: Twilio configured, calling hours in the
 * company's timezone, a callable business line that isn't one of our numbers, one in-flight
 * test per number (partial unique index). Inserts the row FIRST (the callbacks find it by
 * id), then dials. A Twilio refusal completes the test as 'failed'.
 */
async function placeForwardingTest(
  admin: AdminClient,
  target: TestTarget,
  options: { trigger: ForwardingTestTrigger; requestedBy: string | null },
  deps: ForwardingTestDeps,
): Promise<ForwardingTestRow> {
  const now = deps.now?.() ?? Date.now();
  const creds = twilioCreds();
  const base = twilioWebhookBaseUrl();
  if (!creds || !base) {
    throw new ValidationError("Twilio isn't configured on the server yet (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / APP_BASE_URL).");
  }
  const timeZone = target.company.timezone?.trim() || fallbackTimeZone();
  if (!withinCallingHours(timeZone, now)) {
    throw new ValidationError("We only place test calls between 8am and 9pm your time — try again then.");
  }

  const catcher = target.voiceNumber.phone_e164;
  const callerId = forwardingTestCallerId(catcher);
  const problem = businessLineProblem(target.businessLine, {
    catcher,
    callerId,
    sharedSender: toE164(process.env.TWILIO_FROM_NUMBER),
  });
  if (problem || !target.businessLine) throw new ValidationError(problem ?? "Add your business phone number first.");
  const businessLine = target.businessLine;
  if (await isPlatformNumber(admin, businessLine)) {
    throw new ValidationError("Your business number is one of our missed-call numbers — set it to the phone customers call you on.");
  }

  const { data: inserted, error: insertError } = await admin
    .from("forwarding_tests")
    .insert({
      organization_id: target.company.organization_id,
      company_id: target.company.id,
      voice_number_id: target.voiceNumber.id,
      trigger: options.trigger,
      requested_by: options.requestedBy,
      status: "calling",
      caller_id: callerId,
      business_line: businessLine,
      catcher_number: catcher,
      started_at: new Date(now).toISOString(),
      created_at: new Date(now).toISOString(),
    })
    .select("*")
    .single();
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      throw new ValidationError("A forwarding test is already running for this number — give it a minute.");
    }
    throw insertError;
  }
  const row = inserted as ForwardingTestRow;

  // Cost guard: stamp the number's last-test time BEFORE dialling, so a later failure to
  // record the outcome can never make the scheduler re-call it on every pass. If even this
  // write fails, don't place the call.
  const { error: stampError } = await admin
    .from("voice_numbers")
    .update({ forwarding_last_test_at: new Date(now).toISOString() })
    .eq("id", target.voiceNumber.id)
    .eq("organization_id", target.company.organization_id);
  if (stampError) {
    console.error("[forwarding-test] could not stamp forwarding_last_test_at — not calling:", stampError.message);
    await admin
      .from("forwarding_tests")
      .update({ status: "failed", completed_at: new Date(now).toISOString(), error_message: "Could not record the test start." })
      .eq("id", row.id)
      .eq("status", "calling");
    throw stampError;
  }

  const calls = deps.calls ?? createTwilioCallsClient(creds);
  const urls = callbackUrls(base, row.id);
  try {
    const call = await calls.createCall({
      to: businessLine,
      from: callerId,
      twiml: buildForwardingTestAnsweredTwiml(sayVoice()),
      timeoutSeconds: TEST_RING_TIMEOUT_SECONDS,
      statusCallbackUrl: urls.status,
      amdCallbackUrl: urls.amd,
    });
    const { error } = await admin
      .from("forwarding_tests")
      .update({ outbound_call_sid: call.sid, outbound_status: call.status })
      .eq("id", row.id);
    if (error) console.error("[forwarding-test] could not store call sid:", error.message);
    return { ...row, outbound_call_sid: call.sid, outbound_status: call.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[forwarding-test] Twilio refused the test call:", message);
    await completeForwardingTest(admin, row, "failed", {
      error_code: err instanceof TwilioApiError ? err.code : null,
      error_message: message.slice(0, 500),
    }, now);
    return (await loadTest(admin, row.id)) ?? { ...row, status: "failed", error_message: message };
  }
}

async function loadTarget(context: TenantServiceContext, companyId: string): Promise<TestTarget> {
  const voiceNumber = await loadCatcherRow(context, companyId);
  if (!voiceNumber) throw new ValidationError("Set up your catcher number first.");
  const company = await loadCompany(context, companyId);
  if (!company) throw new ValidationError("Company not found.");
  return { voiceNumber, company, businessLine: resolveBusinessLine(company) };
}

/**
 * "Test my forwarding" (owner/admin, via the org API). The catcher number + business line
 * are read through the caller's RLS client; the owner rate limit (1 per 2 min, 10 per 24 h
 * per company) is counted from forwarding_tests — fail closed (a DB error refuses the test).
 */
export async function startOwnerForwardingTest(
  context: TenantServiceContext,
  companyId: string,
  deps: ForwardingTestDeps = {},
): Promise<ForwardingTestView> {
  await assertCompanyInOrganization(context, companyId);
  const target = await loadTarget(context, companyId);
  const admin = createSupabaseAdminClient();
  const now = deps.now?.() ?? Date.now();

  const { data: recent, error } = await admin
    .from("forwarding_tests")
    .select("created_at")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .eq("trigger", "owner")
    .gte("created_at", new Date(now - 24 * 3_600_000).toISOString());
  if (error) throw error;
  const limit = checkOwnerTestRateLimit((recent ?? []) as Array<{ created_at: string }>, now);
  if ("reason" in limit) throw new ForwardingTestRateLimited(limit.reason, limit.retryAfterSeconds);

  const row = await placeForwardingTest(admin, target, { trigger: "owner", requestedBy: context.actorProfileId }, deps);
  return toTestView(row);
}

/** Over the owner-test rate limit (handleRoute → 429 with Retry-After). */
export class ForwardingTestRateLimited extends TooManyRequestsError {}

// ── Status for the wizard (members; RLS reads only) ──────────────────────────

export interface ForwardingVerificationStatus {
  hasCatcher: boolean;
  verifiedAt: string | null;
  lastTestAt: string | null;
  lastTestResult: string | null;
  businessLinePretty: string | null;
  callerIdPretty: string | null;
  /** Why "Test my forwarding" can't run right now (null = it can). */
  blockedReason: string | null;
  latestTest: ForwardingTestView | null;
}

export async function getForwardingVerificationStatus(
  context: TenantServiceContext,
  companyId: string,
  nowMs: number = Date.now(),
): Promise<ForwardingVerificationStatus> {
  await assertCompanyInOrganization(context, companyId);
  const voiceNumber = await loadCatcherRow(context, companyId);
  if (!voiceNumber) {
    return {
      hasCatcher: false,
      verifiedAt: null,
      lastTestAt: null,
      lastTestResult: null,
      businessLinePretty: null,
      callerIdPretty: null,
      blockedReason: "Set up your catcher number first.",
      latestTest: null,
    };
  }
  const company = await loadCompany(context, companyId);
  const businessLine = resolveBusinessLine(company);
  const callerId = forwardingTestCallerId(voiceNumber.phone_e164);

  const { data: tests, error } = await context.supabase
    .from("forwarding_tests")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("voice_number_id", voiceNumber.id)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const latest = ((tests ?? []) as ForwardingTestRow[])[0] ?? null;

  const timeZone = company?.timezone?.trim() || fallbackTimeZone();
  const blockedReason =
    businessLineProblem(businessLine, { catcher: voiceNumber.phone_e164, callerId, sharedSender: toE164(process.env.TWILIO_FROM_NUMBER) }) ??
    (withinCallingHours(timeZone, nowMs) ? null : "Test calls run between 8am and 9pm your time.");

  return {
    hasCatcher: true,
    verifiedAt: voiceNumber.forwarding_verified_at,
    lastTestAt: voiceNumber.forwarding_last_test_at,
    lastTestResult: voiceNumber.forwarding_last_test_result,
    businessLinePretty: businessLine ? prettyPhone(businessLine) : null,
    callerIdPretty: prettyPhone(callerId),
    blockedReason,
    latestTest: latest ? toTestView(latest) : null,
  };
}

// ── Completing a test ────────────────────────────────────────────────────────

type CompletionExtra = Partial<
  Pick<
    ForwardingTestRow,
    | "error_code"
    | "error_message"
    | "forwarded_call_sid"
    | "forwarded_from"
    | "outbound_status"
    | "outbound_answered_by"
    | "outbound_duration_seconds"
  >
>;

/**
 * Apply an outcome to a test (state machine in nextTestStatus: 'passed' always wins,
 * otherwise only an in-flight test takes an outcome), then — only if THIS call made the
 * transition — update the number's verification columns, mark onboarding on a pass, and
 * tell the owner (at most once per transition). Returns the new status or null if unchanged.
 */
export async function completeForwardingTest(
  admin: AdminClient,
  test: ForwardingTestRow,
  outcome: ForwardingTestOutcome,
  extra: CompletionExtra = {},
  nowMs: number = Date.now(),
): Promise<ForwardingTestStatus | null> {
  const next = nextTestStatus(test.status as ForwardingTestStatus, outcome);
  if (!next) return null;
  const nowIso = new Date(nowMs).toISOString();

  // Atomic transition: guarded on the status we decided from, so a racing worker can't
  // apply a second outcome. An upgrade to passed re-arms the owner notification.
  const { data: moved, error } = await admin
    .from("forwarding_tests")
    .update({ ...extra, status: next, completed_at: nowIso, ...(next === "passed" ? { notified_at: null } : {}) })
    .eq("id", test.id)
    .eq("status", test.status)
    .select("id");
  if (error) throw error;
  if ((moved ?? []).length === 0) return null;
  const finalOutcome = next as ForwardingTestOutcome;

  // Verification columns (the contract other features read).
  const { data: vn, error: vnError } = await admin
    .from("voice_numbers")
    .select("id, forwarding_verified_at")
    .eq("id", test.voice_number_id)
    .maybeSingle();
  if (vnError) throw vnError;
  const wasVerified = Boolean((vn as Pick<VoiceNumberRow, "forwarding_verified_at"> | null)?.forwarding_verified_at);
  const { error: patchError } = await admin
    .from("voice_numbers")
    .update(verificationPatch(finalOutcome, nowIso))
    .eq("id", test.voice_number_id)
    .eq("organization_id", test.organization_id);
  if (patchError) throw patchError;

  const updated: ForwardingTestRow = { ...test, ...extra, status: next, completed_at: nowIso };
  if (finalOutcome === "passed") await markOnboardingTestStep(admin, updated, nowIso);
  if (shouldNotifyOwner({ trigger: test.trigger as ForwardingTestTrigger, outcome: finalOutcome, wasVerified })) {
    await notifyOwnerOfResult(admin, updated, finalOutcome, nowIso);
  }
  return next;
}

/**
 * On a pass, complete the wizard's "Test call" step for a catcher-mode company: for the
 * catcher, the test call IS the forwarding test (the Phone step already completes when the
 * number is provisioned). Only when the Phone step was set up in catcher mode, only if not
 * already complete. Best-effort.
 */
async function markOnboardingTestStep(admin: AdminClient, test: ForwardingTestRow, nowIso: string): Promise<void> {
  try {
    const ctx: TenantServiceContext = { organizationId: test.organization_id, actorProfileId: null, supabase: admin };
    const progress = await getOnboardingProgress(ctx, test.company_id);
    const phone = progress.find((p) => p.step === "phone");
    const phoneData = phone?.data && typeof phone.data === "object" && !Array.isArray(phone.data) ? phone.data : {};
    if (phoneData.mode !== CATCHER_MODE) return;
    const step = progress.find((p) => p.step === "test_call");
    if (step?.status === "complete") return;
    const data: Json = { mode: CATCHER_MODE, forwardingVerifiedAt: nowIso, forwardingTestId: test.id };
    await upsertOnboardingStep(ctx, test.company_id, "test_call", { completed: true, data });
    await recordOnboardingEvent(ctx, {
      companyId: test.company_id,
      step: "test_call",
      event: "complete",
      metadata: { mode: CATCHER_MODE, forwardingTestId: test.id, trigger: test.trigger },
    });
  } catch (err) {
    console.error("[forwarding-test] onboarding step update failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * App origin for the owner's "test again" link: the CrankLeads host for a CrankLeads org;
 * APP_BASE_URL (or no link when unset) for everyone else, as before.
 */
async function ownerAppBaseUrl(admin: AdminClient, organizationId: string): Promise<string | null> {
  const brand = await loadOrganizationBrand(admin, organizationId);
  return brand.key === "empirevu" ? process.env.APP_BASE_URL ?? null : appBaseUrlFor(brand);
}

/** SMS to the owner's mobile (email when there is no mobile). Claimed once; best-effort. */
async function notifyOwnerOfResult(admin: AdminClient, test: ForwardingTestRow, outcome: ForwardingTestOutcome, nowIso: string): Promise<void> {
  try {
    const { data: claimed, error } = await admin
      .from("forwarding_tests")
      .update({ notified_at: nowIso })
      .eq("id", test.id)
      .is("notified_at", null)
      .select("id");
    if (error) throw error;
    if ((claimed ?? []).length === 0) return;

    const ctx: TenantServiceContext = { organizationId: test.organization_id, actorProfileId: null, supabase: admin };
    const company = await loadCompany(ctx, test.company_id);
    const owner = await resolveOwnerContacts(ctx, company);
    const message = buildForwardingResultMessage({
      outcome,
      trigger: test.trigger as ForwardingTestTrigger,
      companyName: company?.name ?? null,
      businessLine: test.business_line,
      catcherNumber: test.catcher_number,
      answeredBy: test.outbound_answered_by,
      link: phoneStepLink(await ownerAppBaseUrl(admin, test.organization_id)),
    });
    const useSms = Boolean(owner.phone);
    const result = await deliverMessage({
      context: ctx,
      channel: useSms ? "sms" : "email",
      to: useSms ? owner.phone : owner.email,
      subject: useSms ? null : message.subject,
      body: useSms ? message.sms : message.emailBody,
      companyId: test.company_id,
      contactId: null,
      consentContact: null,
    });
    if (result.status !== "sent") {
      console.warn(`[forwarding-test] owner notice not sent (${result.status}: ${result.reason ?? "-"})`);
    }
  } catch (err) {
    console.error("[forwarding-test] owner notification failed:", err instanceof Error ? err.message : err);
  }
}

// ── The forwarded leg (called from the voice webhook + missed-call worker) ───

/**
 * Voice webhook (BEFORE the durable write, and only for a call whose From is one of our own
 * test caller IDs — see isTestCallerId; customer calls never get here): the forwarding test
 * this leg belongs to, or null. Rule (matchForwardingTest): From == the test's caller_id AND
 * To == its catcher number AND it arrives within TEST_DETECT_WINDOW_MS of the test starting.
 */
export async function findForwardingTestForLeg(
  admin: AdminClient,
  leg: InboundLeg,
  nowMs: number = Date.now(),
): Promise<TestCandidate | null> {
  const from = toE164(leg.from);
  const to = toE164(leg.to);
  if (!from || !to || !isTestCallerId(from, to)) return null;
  const { data, error } = await admin
    .from("forwarding_tests")
    .select("id, organization_id, company_id, status, started_at, caller_id, catcher_number")
    .eq("catcher_number", to)
    .eq("caller_id", from)
    .gte("started_at", new Date(nowMs - TEST_DETECT_WINDOW_MS).toISOString())
    .order("started_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return matchForwardingTest((data ?? []) as TestCandidate[], { from, to }, nowMs, { windowMs: TEST_DETECT_WINDOW_MS });
}

/**
 * Worker: the webhook flagged this call as the forwarded leg of test `testId` — mark the test
 * passed ('passed' is sticky and wins over an earlier finalize, so a backlogged job still
 * counts) and return true; the caller then skips missed_calls / lead / text-back. No
 * re-matching here: the flag is the decision. Only a test of THIS tenant is accepted.
 */
export async function recordFlaggedForwardedLeg(
  admin: AdminClient,
  tenant: { organizationId: string; companyId: string },
  leg: { testId: string; callSid: string; forwardedFrom: string | null },
  nowMs: number = Date.now(),
): Promise<boolean> {
  const test = await loadTest(admin, leg.testId);
  if (!test || test.organization_id !== tenant.organizationId || test.company_id !== tenant.companyId) {
    console.warn(`[forwarding-test] flagged leg ${leg.callSid} names test ${leg.testId}, which isn't this tenant's — ignored.`);
    return false;
  }
  await completeForwardingTest(
    admin,
    test,
    "passed",
    { forwarded_call_sid: leg.callSid, forwarded_from: toE164(leg.forwardedFrom) ?? leg.forwardedFrom },
    nowMs,
  );
  return true;
}

/**
 * A call FROM our own test caller ID (the catcher number itself, or the platform verifier)
 * is never a customer — e.g. a test leg that arrived after the window. Never text it back.
 * Pure (no I/O): the voice webhook uses it to decide whether a test lookup is needed at all.
 */
export function isTestCallerId(from: string | null, catcherNumber: string): boolean {
  const caller = toE164(from);
  if (!caller) return false;
  return caller === toE164(catcherNumber) || caller === forwardingTestVerifierNumber();
}

/**
 * Passive proof: a real customer call that the carrier forwarded from the business line
 * (ForwardedFrom present and — when we know the business line — equal to it) shows
 * forwarding works. Sets forwarding_verified_at only. A call dialled straight to the
 * catcher number (e.g. a customer calling back the text-back number) has no ForwardedFrom
 * and proves nothing. Best-effort.
 */
export async function recordPassiveForwardingProof(
  admin: AdminClient,
  tenant: { organizationId: string; companyId: string; phoneE164: string },
  forwardedFrom: string | null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const forwarded = toE164(forwardedFrom);
    if (!forwarded) return false;
    const ctx: TenantServiceContext = { organizationId: tenant.organizationId, actorProfileId: null, supabase: admin };
    const businessLine = resolveBusinessLine(await loadCompany(ctx, tenant.companyId));
    if (businessLine && businessLine.slice(-10) !== forwarded.slice(-10)) return false;
    const { error } = await admin
      .from("voice_numbers")
      .update({ forwarding_verified_at: new Date(nowMs).toISOString() })
      .eq("organization_id", tenant.organizationId)
      .eq("company_id", tenant.companyId)
      .eq("phone_e164", tenant.phoneE164);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[forwarding-test] passive verification failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Twilio callbacks → worker ────────────────────────────────────────────────

function readField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Durable-queue key for a callback (one job per call × event × status). */
export function forwardingCallbackExternalId(event: string, params: Record<string, string>): string | null {
  if (!params.CallSid) return null;
  const detail = event === "amd" ? params.AnsweredBy ?? "unknown" : params.CallStatus ?? "unknown";
  return `${event}:${params.CallSid}:${detail}`;
}

async function scheduleFinalize(admin: AdminClient, testId: string, runAtMs: number): Promise<void> {
  const { error } = await admin.from("inbound_webhook_jobs").upsert(
    {
      provider: FORWARDING_TEST_JOB_PROVIDER,
      external_id: `finalize:${testId}`,
      payload: toJson({ ForwardingTestId: testId, ForwardingTestEvent: "finalize" }),
      status: "pending",
      max_attempts: 5,
      run_at: new Date(runAtMs).toISOString(),
    },
    { onConflict: "provider,external_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

/** Decide a still-'calling' test from what we have recorded (finalize job / stale sweep). */
async function finalizeTest(admin: AdminClient, test: ForwardingTestRow, nowMs: number, stale: boolean): Promise<void> {
  if (test.status !== "calling") return;
  const outcome = outcomeFromCall({
    callStatus: test.outbound_status,
    answeredBy: test.outbound_answered_by,
    forwardedLegSeen: Boolean(test.forwarded_call_sid),
  });
  if (outcome) {
    await completeForwardingTest(admin, test, outcome, {}, nowMs);
  } else if (stale) {
    await completeForwardingTest(
      admin,
      test,
      "failed",
      { error_message: test.outbound_call_sid ? "No final call status from Twilio." : "The test call was never placed." },
      nowMs,
    );
  }
}

/**
 * Worker handler (provider='twilio_forwarding_test'):
 *   • event=status — record the outbound call's final status; if the test is still in flight,
 *     schedule a finalize TEST_FINALIZE_GRACE_MS later (a forwarded leg / AMD result may still
 *     be in the queue);
 *   • event=amd — record AnsweredBy (human / machine_* / fax / unknown);
 *   • event=finalize — decide the outcome if nothing else has.
 * A callback for an unknown test is ignored (nothing to update).
 */
export async function handleForwardingTestJob(payload: unknown, nowMs: number = Date.now()): Promise<void> {
  const testId = readField(payload, "ForwardingTestId");
  const event = readField(payload, "ForwardingTestEvent");
  if (!testId || !event) throw new Error("Forwarding test job missing ForwardingTestId / ForwardingTestEvent.");
  const admin = createSupabaseAdminClient();
  const test = await loadTest(admin, testId);
  if (!test) {
    console.warn(`[forwarding-test] callback for unknown test ${testId} — ignored.`);
    return;
  }

  if (event === "amd") {
    const answeredBy = readField(payload, "AnsweredBy");
    if (answeredBy && !test.outbound_answered_by) {
      const { error } = await admin.from("forwarding_tests").update({ outbound_answered_by: answeredBy }).eq("id", test.id);
      if (error) throw error;
    }
    return;
  }

  if (event === "status") {
    const callStatus = readField(payload, "CallStatus");
    const duration = Number.parseInt(readField(payload, "CallDuration") ?? "", 10);
    const patch: CompletionExtra = {
      outbound_status: callStatus,
      ...(Number.isFinite(duration) ? { outbound_duration_seconds: duration } : {}),
      ...(readField(payload, "ErrorCode") ? { error_code: readField(payload, "ErrorCode") } : {}),
      ...(readField(payload, "AnsweredBy") && !test.outbound_answered_by ? { outbound_answered_by: readField(payload, "AnsweredBy") } : {}),
    };
    const { error } = await admin.from("forwarding_tests").update(patch).eq("id", test.id);
    if (error) throw error;
    if (test.status === "calling" && isTerminalCallStatus(callStatus)) {
      await scheduleFinalize(admin, test.id, nowMs + TEST_FINALIZE_GRACE_MS);
    }
    return;
  }

  if (event === "finalize") {
    await finalizeTest(admin, test, nowMs, Date.parse(test.started_at) <= nowMs - TEST_STALE_MS);
    return;
  }

  throw new Error(`Unknown forwarding test event: ${event}`);
}

// ── Scheduler (worker runScheduler pass) ─────────────────────────────────────

/** Finish tests stuck in 'calling' (no status callback ever arrived). */
export async function sweepStaleForwardingTests(admin: AdminClient, nowMs: number): Promise<number> {
  const { data, error } = await admin
    .from("forwarding_tests")
    .select("*")
    .eq("status", "calling")
    .lte("started_at", new Date(nowMs - TEST_STALE_MS).toISOString())
    .limit(50);
  if (error) throw error;
  let swept = 0;
  for (const test of (data ?? []) as ForwardingTestRow[]) {
    try {
      await finalizeTest(admin, test, nowMs, true);
      swept += 1;
    } catch (err) {
      console.error("[forwarding-test] stale sweep failed for", test.id, err instanceof Error ? err.message : err);
    }
  }
  return swept;
}

/**
 * May the scheduler place billed test calls for this org? No for a cancelled subscription,
 * a missing org row, or an org that never subscribed ('none') unless it is an internal
 * house tenant (plan 'internal'). trialing / active / past_due keep their retests.
 */
export function orgEligibleForRetests(org: Pick<Tables<"organizations">, "plan" | "subscription_status"> | null): boolean {
  if (!org) return false;
  const status = (org.subscription_status ?? "none").toLowerCase();
  if (status === "canceled" || status === "cancelled") return false;
  if (status === "none") return org.plan === "internal";
  return true;
}

/**
 * One retest pass (called from runScheduler each minute). Re-tests verified catcher numbers
 * weekly and unverified ones daily for their first 14 days (retestDecision), only Mon–Fri
 * 10:00–16:00 in the company's timezone, at most MAX_SCHEDULED_TESTS_PER_PASS calls per pass
 * and MAX_SCHEDULED_TESTS_PER_NUMBER_PER_DAY per number. Cancelled orgs are skipped.
 * Never throws — per-number failures are logged and the loop continues.
 */
export async function processForwardingRetests(
  admin: AdminClient,
  nowMs: number = Date.now(),
  deps: ForwardingTestDeps = {},
): Promise<number> {
  let placed = 0;
  try {
    await sweepStaleForwardingTests(admin, nowMs);
    if (!twilioCreds() || !twilioWebhookBaseUrl()) return 0;

    const { data: numbers, error } = await admin
      .from("voice_numbers")
      .select("*")
      .eq("provider", "twilio")
      .eq("mode", CATCHER_MODE)
      .eq("active", true)
      .limit(1000);
    if (error) throw error;
    const rows = (numbers ?? []) as VoiceNumberRow[];
    if (rows.length === 0) return 0;

    const { data: companies, error: companyError } = await admin
      .from("companies")
      .select(COMPANY_FIELDS)
      .in("id", Array.from(new Set(rows.map((r) => r.company_id))));
    if (companyError) throw companyError;
    const companyById = new Map(((companies ?? []) as CompanyFields[]).map((c) => [c.id, c]));

    // Churned orgs get no billed test calls: skip cancelled subscriptions, and orgs that
    // never had one (subscription_status 'none') unless they are an internal house tenant.
    const { data: orgs, error: orgError } = await admin
      .from("organizations")
      .select("id, plan, subscription_status")
      .in("id", Array.from(new Set(rows.map((r) => r.organization_id))));
    if (orgError) throw orgError;
    const orgById = new Map(
      ((orgs ?? []) as Array<Pick<Tables<"organizations">, "id" | "plan" | "subscription_status">>).map((o) => [o.id, o]),
    );

    const { data: tests, error: testError } = await admin
      .from("forwarding_tests")
      .select("voice_number_id, trigger, status, started_at")
      .in("voice_number_id", rows.map((r) => r.id))
      .gte("started_at", new Date(nowMs - 15 * 24 * 3_600_000).toISOString());
    if (testError) throw testError;
    const testRows = (tests ?? []) as Array<Pick<ForwardingTestRow, "voice_number_id" | "trigger" | "status" | "started_at">>;

    for (const vn of rows) {
      if (placed >= MAX_SCHEDULED_TESTS_PER_PASS) break;
      const company = companyById.get(vn.company_id);
      if (!company || company.organization_id !== vn.organization_id) continue;
      if (!orgEligibleForRetests(orgById.get(vn.organization_id) ?? null)) continue;
      const mine = testRows.filter((t) => t.voice_number_id === vn.id);
      const scheduled = mine.filter((t) => t.trigger === "scheduled");
      const candidate: RetestCandidate = {
        voiceNumberId: vn.id,
        createdAt: vn.created_at,
        verifiedAt: vn.forwarding_verified_at,
        lastTestAt: vn.forwarding_last_test_at,
        timeZone: company.timezone?.trim() || fallbackTimeZone(),
        scheduledAttempts: scheduled.length,
        scheduledLast24h: scheduled.filter((t) => nowMs - Date.parse(t.started_at) < 24 * 3_600_000).length,
        inFlight: mine.some((t) => t.status === "calling"),
        hasBusinessLine: resolveBusinessLine(company) !== null,
      };
      if (!retestDecision(candidate, nowMs).due) continue;
      try {
        await placeForwardingTest(
          admin,
          { voiceNumber: vn, company, businessLine: resolveBusinessLine(company) },
          { trigger: "scheduled", requestedBy: null },
          { ...deps, now: () => nowMs },
        );
        placed += 1;
      } catch (err) {
        console.error("[forwarding-test] scheduled retest skipped for", vn.id, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[forwarding-test] retest pass failed:", err instanceof Error ? err.message : err);
  }
  return placed;
}
