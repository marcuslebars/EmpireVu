/**
 * Forwarding verification — the service over an in-memory DB (docs/missed-call-catcher.md →
 * Forwarding verification): owner-triggered test (guards, rate limit, quiet hours, caller
 * ID), the outcome flow from Twilio callbacks + the forwarded leg (via the real
 * handleMissedCall), voice_numbers column contract, owner notification, onboarding step,
 * passive proof, stale sweep and the scheduled retest pass.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, fakeTenantContext, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  sent: [] as Array<Record<string, unknown>>,
  owner: { email: "owner@muskoka.test", phone: "+17055558888" as string | null },
  intake: 0,
  steps: [] as Array<{ companyId: string; step: string; input: Record<string, unknown> }>,
  progress: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/workflow-engine/messaging", () => ({
  resolveOwnerContacts: () => Promise.resolve(h.owner),
  deliverMessage: (input: Record<string, unknown>) => {
    h.sent.push(input);
    return Promise.resolve({ status: "sent", body: input.body });
  },
}));
vi.mock("@/server/services/onboarding", () => ({
  getOnboardingProgress: () => Promise.resolve(h.progress),
  upsertOnboardingStep: (_ctx: unknown, companyId: string, step: string, input: Record<string, unknown>) => {
    h.steps.push({ companyId, step, input });
    return Promise.resolve({});
  },
  recordOnboardingEvent: () => Promise.resolve(),
}));
vi.mock("@/server/services/lead-intake/intake", () => ({
  handleLeadIntake: () => {
    h.intake += 1;
    return Promise.resolve({ ok: true, leadId: `lead_${h.intake}` });
  },
}));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({
  emitActivityEventAndDispatch: () => Promise.resolve({ activityEvent: { id: "evt" }, workflowEventJob: null }),
}));
vi.mock("@/server/services/activity-events", () => ({
  createActivityEvent: () => Promise.resolve({ id: "evt" }),
}));

import { TooManyRequestsError, ValidationError } from "@/server/organizations/context";
import { TwilioApiError, type CreateTestCallInput, type TwilioCallsClient } from "@/server/services/twilio/calls";
import {
  findForwardingTestForLeg,
  FORWARDING_TEST_LEG_KEY,
  getForwardingVerificationStatus,
  handleForwardingTestJob,
  isTestCallerId,
  orgEligibleForRetests,
  processForwardingRetests,
  startOwnerForwardingTest,
  sweepStaleForwardingTests,
} from "@/server/services/twilio/forwarding-test";
import { handleMissedCall } from "@/server/services/twilio/missed-call";

const ORG = "org-1";
const COMPANY = "co-1";
const VN = "vn-1";
const CATCHER = "+17055550100";
const BUSINESS = "+17055559999";
const T0 = Date.parse("2026-10-06T14:00:00Z"); // Tue 10:00 Toronto

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

function seed(
  over: { company?: Record<string, unknown>; voiceNumber?: Record<string, unknown>; org?: Record<string, unknown> } = {},
): FakeDb {
  return createFakeDb({
    organizations: [{ id: ORG, plan: "crankleads", subscription_status: "active", ...over.org }],
    voice_numbers: [
      {
        id: VN,
        organization_id: ORG,
        company_id: COMPANY,
        phone_e164: CATCHER,
        provider: "twilio",
        mode: "missed_call_catcher",
        active: true,
        brand_label: null,
        created_at: new Date(T0 - 60 * 864e5).toISOString(),
        forwarding_verified_at: null,
        forwarding_last_test_at: null,
        forwarding_last_test_result: null,
        ...over.voiceNumber,
      },
    ],
    companies: [
      {
        id: COMPANY,
        organization_id: ORG,
        name: "Muskoka Plumbing",
        slug: "muskoka-plumbing",
        timezone: "America/Toronto",
        brand_reply_phone: null,
        owner_phone_e164: BUSINESS,
        owner_email: "owner@muskoka.test",
        ...over.company,
      },
    ],
    forwarding_tests: [],
    inbound_webhook_jobs: [],
  });
}

function fakeCalls(impl?: (input: CreateTestCallInput) => Promise<{ sid: string; status: string | null }>) {
  const calls: CreateTestCallInput[] = [];
  const client: TwilioCallsClient = {
    createCall: (input) => {
      calls.push(input);
      return impl ? impl(input) : Promise.resolve({ sid: `CAout${calls.length}`, status: "queued" });
    },
  };
  return { client, calls };
}

const db = (): FakeDb => h.db!;
const ctx = () => fakeTenantContext(db(), ORG, "user-1");
const vn = () => db().tables.voice_numbers[0];
const tests = () => db().tables.forwarding_tests;

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "AC123";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.APP_BASE_URL = "https://app.example.test";
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.TWILIO_FORWARDING_TEST_FROM;
  delete process.env.TWILIO_FROM_NUMBER;
  delete process.env.MISSED_CALL_TEXTBACK_WINDOW_MINUTES;
  h.db = seed();
  h.sent = [];
  h.owner = { email: "owner@muskoka.test", phone: "+17055558888" };
  h.intake = 0;
  h.steps = [];
  h.progress = [{ step: "phone", status: "complete", data: { mode: "missed_call_catcher" } }];
});

async function startTest(calls = fakeCalls(), now = T0) {
  const view = await startOwnerForwardingTest(ctx(), COMPANY, { calls: calls.client, now: () => now });
  return { view, calls };
}

describe("startOwnerForwardingTest", () => {
  it("calls the stored business line from the catcher number with a long ring + callbacks", async () => {
    const { view, calls } = await startTest();
    expect(view).toMatchObject({ status: "calling", trigger: "owner", callerIdPretty: "(705) 555-0100", businessLinePretty: "(705) 555-9999" });
    expect(calls.calls).toHaveLength(1);
    const call = calls.calls[0];
    expect(call).toMatchObject({ to: BUSINESS, from: CATCHER, timeoutSeconds: 40 });
    expect(call.statusCallbackUrl).toBe(`https://app.example.test/api/twilio/voice/forwarding-test?testId=${view.id}&event=status`);
    expect(call.amdCallbackUrl).toBe(`https://app.example.test/api/twilio/voice/forwarding-test?testId=${view.id}&event=amd`);
    expect(call.twiml).toContain("<Say");
    expect(tests()[0]).toMatchObject({
      organization_id: ORG,
      company_id: COMPANY,
      voice_number_id: VN,
      status: "calling",
      caller_id: CATCHER,
      business_line: BUSINESS,
      outbound_call_sid: "CAout1",
      requested_by: "user-1",
    });
    // The insert happens BEFORE the call (callbacks find the row by id).
    expect(db().ops.findIndex((o) => o.table === "forwarding_tests" && o.op === "insert")).toBeGreaterThanOrEqual(0);
  });

  it("prefers the public business phone (brand_reply_phone) over the owner phone", async () => {
    h.db = seed({ company: { brand_reply_phone: "(705) 555-7777" } });
    const { calls } = await startTest();
    expect(calls.calls[0].to).toBe("+17055557777");
  });

  it("uses the platform verifier as caller ID when TWILIO_FORWARDING_TEST_FROM is set", async () => {
    process.env.TWILIO_FORWARDING_TEST_FROM = "416-555-0111";
    const { calls, view } = await startTest();
    expect(calls.calls[0].from).toBe("+14165550111");
    expect(view.callerIdPretty).toBe("(416) 555-0111");
  });

  it("rate-limits per company: 1 per 2 minutes (429 error type)", async () => {
    await startTest();
    // Finish the first so the in-flight guard isn't what trips.
    tests()[0].status = "passed";
    const err = await startTest(fakeCalls(), T0 + 60_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect((err as TooManyRequestsError).retryAfterSeconds).toBe(60);
    expect(tests()).toHaveLength(1);
  });

  it("rate-limits per company: 10 owner tests per 24 h (scheduled tests don't count)", async () => {
    for (let i = 0; i < 10; i++) {
      tests().push({ id: `old-${i}`, organization_id: ORG, company_id: COMPANY, trigger: "owner", status: "passed", created_at: new Date(T0 - (i + 1) * 3_600_000).toISOString() });
    }
    await expect(startTest()).rejects.toBeInstanceOf(TooManyRequestsError);
    for (const t of tests()) t.trigger = "scheduled";
    await expect(startTest()).resolves.toBeTruthy();
  });

  it("never calls outside 8am–9pm company time", async () => {
    const calls = fakeCalls();
    await expect(startTest(calls, Date.parse("2026-10-07T01:30:00Z"))).rejects.toThrow(/between 8am and 9pm/); // 21:30
    expect(calls.calls).toHaveLength(0);
    expect(tests()).toHaveLength(0);
  });

  it("refuses without a callable business line — or when it's one of our numbers", async () => {
    h.db = seed({ company: { owner_phone_e164: null } });
    await expect(startTest()).rejects.toBeInstanceOf(ValidationError);
    h.db = seed({ company: { owner_phone_e164: CATCHER } });
    await expect(startTest()).rejects.toThrow(/missed-call number/);
    h.db = seed();
    db().tables.voice_numbers.push({ id: "other", organization_id: "org-2", company_id: "co-2", phone_e164: BUSINESS, provider: "retell", mode: "ai_receptionist", active: true });
    await expect(startTest()).rejects.toThrow(/missed-call number/);
  });

  it("refuses without a catcher number, and for another org's company", async () => {
    db().tables.voice_numbers[0].active = false;
    await expect(startTest()).rejects.toThrow(/catcher number first/);
    h.db = seed();
    await expect(startOwnerForwardingTest(fakeTenantContext(db(), "org-2"), COMPANY, { calls: fakeCalls().client, now: () => T0 })).rejects.toThrow();
  });

  it("stamps forwarding_last_test_at when the test is CREATED, before dialling (cost guard)", async () => {
    let stampedBeforeDial: unknown = "unset";
    await startTest(
      fakeCalls(() => {
        stampedBeforeDial = vn().forwarding_last_test_at;
        return Promise.resolve({ sid: "CAout1", status: "queued" });
      }),
    );
    expect(stampedBeforeDial).toBe(new Date(T0).toISOString());
  });

  it("if the start stamp can't be written, no call is placed", async () => {
    const calls = fakeCalls();
    db().failNext("voice_numbers", { message: "db down" }, "update");
    await expect(startTest(calls)).rejects.toBeTruthy();
    expect(calls.calls).toHaveLength(0);
    expect(tests()[0]).toMatchObject({ status: "failed" });
  });

  it("a Twilio refusal (our side) completes the test as failed, KEEPS verification and tells the owner", async () => {
    vn().forwarding_verified_at = "2026-09-01T00:00:00.000Z";
    const { view } = await startTest(fakeCalls(() => Promise.reject(new TwilioApiError("The 'To' number is not valid.", 400, "21211"))));
    expect(view.status).toBe("failed");
    expect(tests()[0]).toMatchObject({ status: "failed", error_code: "21211" });
    expect(vn()).toMatchObject({ forwarding_verified_at: "2026-09-01T00:00:00.000Z", forwarding_last_test_result: "failed" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ channel: "sms", to: "+17055558888", companyId: COMPANY, contactId: null, consentContact: null });
  });
});

/** Run a status / amd / finalize job the way the worker would. */
const job = (testId: string, event: string, extra: Record<string, string> = {}, now = T0 + 60_000) =>
  handleForwardingTestJob({ ForwardingTestId: testId, ForwardingTestEvent: event, CallSid: "CAout1", ...extra }, now);

/**
 * What the voice webhook does: decide (only for a call from our own test caller ID) and
 * stamp the test id into the durable payload; then the worker handles that payload at
 * `workerAt` (defaults to the arrival time).
 */
async function viaWebhook(params: Record<string, string>, arrivedAt: number, workerAt = arrivedAt) {
  const payload: Record<string, string> = { ...params };
  if (isTestCallerId(params.From ?? null, params.To)) {
    const match = await findForwardingTestForLeg(db().client as never, { from: params.From ?? null, to: params.To }, arrivedAt);
    if (match) payload[FORWARDING_TEST_LEG_KEY] = match.id;
  }
  return { payload, result: await handleMissedCall(payload, workerAt) };
}

const forwardedLeg = async (over: Record<string, string> = {}, arrivedAt = T0 + 25_000, workerAt = arrivedAt) =>
  (await viaWebhook({ CallSid: "CAleg1", From: CATCHER, To: CATCHER, CallStatus: "ringing", ...over }, arrivedAt, workerAt)).result;

describe("outcomes", () => {
  it("forwarded leg → passed: verified, owner texted ✅, onboarding test step completed, no lead / missed call", async () => {
    const { view } = await startTest();
    const result = await forwardedLeg();
    expect(result.status).toBe("forwarding_test");
    expect(h.intake).toBe(0);
    expect(db().tables.missed_calls ?? []).toHaveLength(0);
    expect(tests()[0]).toMatchObject({ status: "passed", forwarded_call_sid: "CAleg1" });
    expect(vn()).toMatchObject({ forwarding_last_test_result: "passed" });
    expect(vn().forwarding_verified_at).toBeTruthy();
    expect(h.sent.map((m) => m.body)).toEqual(["✅ Missed-call text-back is live for Muskoka Plumbing."]);
    expect(h.steps).toEqual([
      { companyId: COMPANY, step: "test_call", input: expect.objectContaining({ completed: true }) },
    ]);

    // The outbound leg's final status afterwards changes nothing (passed is sticky).
    await job(view.id, "status", { CallStatus: "completed", CallDuration: "3" });
    await job(view.id, "finalize", {}, T0 + 120_000);
    expect(tests()[0].status).toBe("passed");
    expect(h.sent).toHaveLength(1);
  });

  it("trade-off: a leg whose caller ID the carrier rewrote to the business line is NOT the test — it's a normal missed call", async () => {
    await startTest();
    const { payload, result } = await viaWebhook({ CallSid: "CArew", From: BUSINESS, To: CATCHER }, T0 + 25_000);
    expect(payload[FORWARDING_TEST_LEG_KEY]).toBeUndefined();
    expect(result.status).toBe("emitted");
    expect(h.intake).toBe(1);
    expect(tests()[0].status).toBe("calling");
  });

  it("the worker trusts the webhook's flag even when it processes the job late (queue backlog)", async () => {
    const { view } = await startTest();
    // Leg arrived at +25 s (flagged), outbound finalized as not_forwarded, worker runs 20 min later.
    const { payload } = await viaWebhook({ CallSid: "CAlate0", From: "+16475550000", To: CATCHER }, T0 + 25_000);
    expect(payload[FORWARDING_TEST_LEG_KEY]).toBeUndefined();
    await job(view.id, "status", { CallStatus: "no-answer" });
    await job(view.id, "finalize", {}, T0 + 110_000);
    expect(tests()[0].status).toBe("not_forwarded");
    const result = await handleMissedCall(
      { CallSid: "CAleg1", From: CATCHER, To: CATCHER, [FORWARDING_TEST_LEG_KEY]: view.id },
      T0 + 20 * 60_000,
    );
    expect(result.status).toBe("forwarding_test");
    expect(tests()[0].status).toBe("passed");
  });

  it("a flag naming another tenant's test is ignored (never swallows a customer)", async () => {
    tests().push({ id: "foreign", organization_id: "org-2", company_id: "co-2", status: "calling", started_at: new Date(T0).toISOString(), caller_id: CATCHER, catcher_number: "+17055550111", trigger: "owner" });
    const result = await handleMissedCall({ CallSid: "CAx", From: "+16475550123", To: CATCHER, [FORWARDING_TEST_LEG_KEY]: "foreign" }, T0);
    expect(result.status).toBe("emitted");
    expect(h.intake).toBe(1);
    expect(tests()[0].status).toBe("calling");
  });

  it("does not mark onboarding for an AI-receptionist company", async () => {
    h.progress = [{ step: "phone", status: "complete", data: { agentId: "agent_1" } }];
    await startTest();
    await forwardedLeg();
    expect(h.steps).toHaveLength(0);
  });

  it("rang out (no-answer) → finalize after the grace → not_forwarded, verification cleared, fix SMS", async () => {
    vn().forwarding_verified_at = "2026-09-01T00:00:00.000Z";
    const { view } = await startTest();
    await job(view.id, "status", { CallStatus: "no-answer" });
    expect(tests()[0].status).toBe("calling"); // not decided yet — a leg may still be queued
    const finalize = db().tables.inbound_webhook_jobs.find((j) => j.external_id === `finalize:${view.id}`);
    expect(finalize).toMatchObject({ provider: "twilio_forwarding_test", status: "pending" });
    expect(Date.parse(String(finalize?.run_at))).toBe(T0 + 60_000 + 45_000);

    await job(view.id, "finalize", {}, T0 + 110_000);
    expect(tests()[0].status).toBe("not_forwarded");
    expect(vn()).toMatchObject({ forwarding_verified_at: null, forwarding_last_test_result: "not_forwarded" });
    expect(String(h.sent[0].body)).toContain("rang out instead of forwarding");
    expect(String(h.sent[0].body)).toContain("**004*+17055550100#");
    expect(String(h.sent[0].body)).toContain("https://app.example.test/onboarding?step=phone");
  });

  it("voicemail picked up (AMD machine) → not_forwarded 'went to voicemail'", async () => {
    const { view } = await startTest();
    await job(view.id, "amd", { AnsweredBy: "machine_end_beep" });
    await job(view.id, "status", { CallStatus: "completed", CallDuration: "22" });
    await job(view.id, "finalize", {}, T0 + 110_000);
    expect(tests()[0]).toMatchObject({ status: "not_forwarded", outbound_answered_by: "machine_end_beep", outbound_duration_seconds: 22 });
    expect(String(h.sent[0].body)).toContain("went to voicemail");
  });

  it("answered by a person → answered; verification untouched; asks to retry", async () => {
    vn().forwarding_verified_at = "2026-09-01T00:00:00.000Z";
    const { view } = await startTest();
    await job(view.id, "amd", { AnsweredBy: "human" });
    await job(view.id, "status", { CallStatus: "completed" });
    await job(view.id, "finalize", {}, T0 + 110_000);
    expect(tests()[0].status).toBe("answered");
    expect(vn()).toMatchObject({ forwarding_verified_at: "2026-09-01T00:00:00.000Z", forwarding_last_test_result: "answered" });
    expect(String(h.sent[0].body)).toContain("was answered");
  });

  it("busy → inconclusive: verification kept, no 'not working' message", async () => {
    vn().forwarding_verified_at = "2026-09-01T00:00:00.000Z";
    const { view } = await startTest();
    await job(view.id, "status", { CallStatus: "busy" });
    await job(view.id, "finalize", {}, T0 + 110_000);
    expect(tests()[0].status).toBe("busy");
    expect(vn()).toMatchObject({ forwarding_verified_at: "2026-09-01T00:00:00.000Z", forwarding_last_test_result: "busy" });
    expect(String(h.sent[0].body)).toContain("busy signal");
    expect(String(h.sent[0].body)).not.toContain("isn't working");
  });

  it("a late forwarded leg (From == our caller ID, inside the window) upgrades an earlier failure to passed and re-notifies", async () => {
    const { view } = await startTest();
    await job(view.id, "status", { CallStatus: "no-answer" });
    await job(view.id, "finalize", {}, T0 + 110_000);
    expect(tests()[0].status).toBe("not_forwarded");
    expect((await forwardedLeg({ CallSid: "CAlate" }, T0 + 150_000)).status).toBe("forwarding_test");
    expect(tests()[0].status).toBe("passed");
    expect(vn().forwarding_verified_at).toBeTruthy();
    expect(h.sent).toHaveLength(2);
    expect(String(h.sent[0].body)).toMatch(/^Missed-call text-back for Muskoka Plumbing isn't working/);
    expect(String(h.sent[1].body)).toBe("✅ Missed-call text-back is live for Muskoka Plumbing.");
  });

  it("owner without a mobile gets the email instead", async () => {
    h.owner = { email: "owner@muskoka.test", phone: null };
    await startTest();
    await forwardedLeg();
    expect(h.sent[0]).toMatchObject({ channel: "email", to: "owner@muskoka.test", subject: "Missed-call text-back is live for Muskoka Plumbing" });
  });

  it("a callback for an unknown test is ignored; a stale in-flight test is swept to failed", async () => {
    await expect(job("00000000-0000-4000-8000-000000000000", "status", { CallStatus: "completed" })).resolves.toBeUndefined();
    await startTest();
    expect(await sweepStaleForwardingTests(db().client as never, T0 + 6 * 60_000)).toBe(1);
    expect(tests()[0]).toMatchObject({ status: "failed", error_message: "No final call status from Twilio." });
  });
});

describe("handleMissedCall guards", () => {
  it("a call from our own test caller ID outside any test never texts / files a lead", async () => {
    const result = await forwardedLeg();
    expect(result.status).toBe("test_caller");
    expect(h.intake).toBe(0);
  });

  it("a real customer during a test is a normal missed call", async () => {
    await startTest();
    const result = await handleMissedCall({ CallSid: "CAcust", From: "+16475550123", To: CATCHER }, T0 + 20_000);
    expect(result.status).toBe("emitted");
    expect(h.intake).toBe(1);
    expect(tests()[0].status).toBe("calling");
  });

  it("a customer forwarded FROM the business line during a test, and 20 min after it, gets a lead + text-back", async () => {
    const { view } = await startTest();
    const during = await viaWebhook({ CallSid: "CAc-during", From: "+16475550123", To: CATCHER, ForwardedFrom: BUSINESS }, T0 + 20_000);
    expect(during.payload[FORWARDING_TEST_LEG_KEY]).toBeUndefined();
    expect(during.result.status).toBe("emitted"); // call.missed → missed-call text-back recipe
    expect(tests()[0].status).toBe("calling");
    await job(view.id, "status", { CallStatus: "no-answer" });
    await job(view.id, "finalize", {}, T0 + 110_000);
    const after = await viaWebhook({ CallSid: "CAc-after", From: "+16475550124", To: CATCHER, ForwardedFrom: BUSINESS }, T0 + 20 * 60_000);
    expect(after.payload[FORWARDING_TEST_LEG_KEY]).toBeUndefined();
    expect(after.result.status).toBe("emitted");
    expect(h.intake).toBe(2);
    expect(db().tables.missed_calls).toHaveLength(2);
    expect(tests()[0].status).toBe("not_forwarded");
  });

  it("the owner calling the catcher back (business line or cell) after not_forwarded is a normal missed call — never a pass", async () => {
    const { view } = await startTest();
    await job(view.id, "status", { CallStatus: "no-answer" });
    await job(view.id, "finalize", {}, T0 + 110_000);
    expect(tests()[0].status).toBe("not_forwarded");
    const fromLine = await viaWebhook({ CallSid: "CAown1", From: BUSINESS, To: CATCHER }, T0 + 120_000);
    const fromCell = await viaWebhook({ CallSid: "CAown2", From: "+17055558888", To: CATCHER }, T0 + 130_000);
    expect(fromLine.payload[FORWARDING_TEST_LEG_KEY]).toBeUndefined();
    expect(fromLine.result.status).toBe("emitted");
    expect(fromCell.result.status).toBe("emitted");
    expect(tests()[0].status).toBe("not_forwarded");
    expect(vn()).toMatchObject({ forwarding_verified_at: null, forwarding_last_test_result: "not_forwarded" });
  });

  it("a leg from our caller ID after the detection window is not flagged and never files a lead", async () => {
    await startTest();
    const late = await viaWebhook({ CallSid: "CAtoolate", From: CATCHER, To: CATCHER }, T0 + 4 * 60_000);
    expect(late.payload[FORWARDING_TEST_LEG_KEY]).toBeUndefined();
    expect(late.result.status).toBe("test_caller");
    expect(h.intake).toBe(0);
    expect(tests()[0].status).toBe("calling");
  });

  it("passive proof: a real call forwarded FROM the business line sets forwarding_verified_at", async () => {
    await handleMissedCall({ CallSid: "CAc1", From: "+16475550123", To: CATCHER, ForwardedFrom: BUSINESS }, T0);
    expect(vn().forwarding_verified_at).toBe(new Date(T0).toISOString());
  });

  it("no passive proof without ForwardedFrom, or from a different line", async () => {
    await handleMissedCall({ CallSid: "CAc2", From: "+16475550123", To: CATCHER }, T0);
    await handleMissedCall({ CallSid: "CAc3", From: "+16475550124", To: CATCHER, ForwardedFrom: "+16475550000" }, T0);
    expect(vn().forwarding_verified_at).toBeNull();
  });
});

describe("getForwardingVerificationStatus", () => {
  it("returns the column contract + latest test for the wizard", async () => {
    vn().forwarding_verified_at = "2026-10-01T15:00:00.000Z";
    vn().forwarding_last_test_result = "passed";
    await startTest();
    const status = await getForwardingVerificationStatus(ctx(), COMPANY, T0);
    expect(status).toMatchObject({
      hasCatcher: true,
      verifiedAt: "2026-10-01T15:00:00.000Z",
      lastTestResult: "passed",
      businessLinePretty: "(705) 555-9999",
      callerIdPretty: "(705) 555-0100",
      blockedReason: null,
      latestTest: { status: "calling", trigger: "owner" },
    });
    const night = await getForwardingVerificationStatus(ctx(), COMPANY, Date.parse("2026-10-07T03:00:00Z"));
    expect(night.blockedReason).toMatch(/8am and 9pm/);
  });
});

describe("processForwardingRetests (worker scheduler)", () => {
  const LATE = Date.parse("2026-10-06T19:59:00Z"); // Tue 15:59 Toronto
  const retest = (now = LATE, calls = fakeCalls()) => processForwardingRetests(db().client as never, now, { calls: calls.client }).then((n) => ({ n, calls }));

  it("re-tests a number verified 8 days ago (weekday afternoon), silently on pass", async () => {
    vn().forwarding_verified_at = new Date(LATE - 8 * 864e5).toISOString();
    const { n, calls } = await retest();
    expect(n).toBe(1);
    expect(calls.calls[0]).toMatchObject({ to: BUSINESS, from: CATCHER });
    expect(tests()[0]).toMatchObject({ trigger: "scheduled", requested_by: null });
    expect(vn().forwarding_last_test_at).toBe(new Date(LATE).toISOString()); // stamped at creation
    await viaWebhook({ CallSid: "CAleg", From: CATCHER, To: CATCHER }, LATE + 20_000);
    expect(tests()[0].status).toBe("passed");
    expect(h.sent).toHaveLength(0); // still fine → no weekly spam
  });

  it("a verified number that stopped forwarding: cleared + 'Heads up' SMS", async () => {
    vn().forwarding_verified_at = new Date(LATE - 8 * 864e5).toISOString();
    await retest();
    await job(tests()[0].id as string, "status", { CallStatus: "no-answer" }, LATE + 50_000);
    await job(tests()[0].id as string, "finalize", {}, LATE + 100_000);
    expect(vn().forwarding_verified_at).toBeNull();
    expect(String(h.sent[0].body)).toMatch(/^Heads up: missed-call text-back for Muskoka Plumbing isn't working/);
  });

  it("never at night or on weekends; not before a new number's grace; not in flight", async () => {
    vn().forwarding_verified_at = new Date(LATE - 8 * 864e5).toISOString();
    expect((await retest(Date.parse("2026-10-07T02:30:00Z"))).n).toBe(0); // 22:30
    expect((await retest(Date.parse("2026-10-10T17:00:00Z"))).n).toBe(0); // Saturday
    vn().forwarding_verified_at = null;
    vn().created_at = new Date(LATE - 3_600_000).toISOString();
    expect((await retest()).n).toBe(0);
    vn().created_at = new Date(LATE - 3 * 864e5).toISOString();
    tests().push({ id: "busy", voice_number_id: VN, trigger: "owner", status: "calling", started_at: new Date(LATE - 60_000).toISOString(), organization_id: ORG, company_id: COMPANY });
    expect((await retest()).n).toBe(0);
  });

  it("an unverified new number is re-tested daily, at most 5 scheduled attempts", async () => {
    vn().created_at = new Date(LATE - 3 * 864e5).toISOString();
    expect((await retest()).n).toBe(1);
    tests().length = 0;
    for (let i = 0; i < 5; i++) {
      tests().push({ id: `s${i}`, voice_number_id: VN, trigger: "scheduled", status: "not_forwarded", started_at: new Date(LATE - (i + 1) * 864e5).toISOString(), organization_id: ORG, company_id: COMPANY });
    }
    vn().forwarding_last_test_at = new Date(LATE - 864e5).toISOString();
    expect((await retest()).n).toBe(0);
  });

  it("a scheduled busy keeps verification and sends no 'not working' SMS", async () => {
    vn().forwarding_verified_at = new Date(LATE - 8 * 864e5).toISOString();
    await retest();
    await job(tests()[0].id as string, "status", { CallStatus: "busy" }, LATE + 50_000);
    await job(tests()[0].id as string, "finalize", {}, LATE + 100_000);
    expect(tests()[0].status).toBe("busy");
    expect(vn().forwarding_verified_at).toBe(new Date(LATE - 8 * 864e5).toISOString());
    expect(h.sent).toHaveLength(0);
  });

  it("a scheduled failed (our side) keeps verification and stays quiet", async () => {
    vn().forwarding_verified_at = new Date(LATE - 8 * 864e5).toISOString();
    await retest(LATE, fakeCalls(() => Promise.reject(new TwilioApiError("Twilio down", 500, "20500"))));
    expect(tests()[0].status).toBe("failed");
    expect(vn().forwarding_verified_at).toBe(new Date(LATE - 8 * 864e5).toISOString());
    expect(h.sent).toHaveLength(0);
  });

  it("skips cancelled orgs and orgs without a subscription (internal house tenants still tested)", async () => {
    vn().forwarding_verified_at = new Date(LATE - 8 * 864e5).toISOString();
    db().tables.organizations[0].subscription_status = "canceled";
    expect((await retest()).n).toBe(0);
    db().tables.organizations[0].subscription_status = "none";
    expect((await retest()).n).toBe(0);
    db().tables.organizations[0].plan = "internal";
    expect((await retest()).n).toBe(1);
    expect(orgEligibleForRetests({ plan: "crankleads", subscription_status: "past_due" })).toBe(true);
    expect(orgEligibleForRetests({ plan: "crankleads", subscription_status: "trialing" })).toBe(true);
    expect(orgEligibleForRetests(null)).toBe(false);
  });

  it("cost guard: even if the outcome is never recorded, at most 2 scheduled calls per number per 24 h", async () => {
    vn().created_at = new Date(LATE - 3 * 864e5).toISOString();
    const calls = fakeCalls();
    let total = 0;
    for (let pass = 0; pass < 5; pass++) {
      // Simulate a broken completion path: the test ends, but the number's columns are reset.
      for (const t of tests()) t.status = "failed";
      vn().forwarding_last_test_at = null;
      total += (await retest(LATE - 10 * 60_000 + pass * 60_000, calls)).n;
    }
    expect(total).toBe(2);
    expect(calls.calls).toHaveLength(2);
  });

  it("does nothing when Twilio isn't configured", async () => {
    vn().forwarding_verified_at = new Date(LATE - 8 * 864e5).toISOString();
    delete process.env.TWILIO_AUTH_TOKEN;
    expect((await retest()).n).toBe(0);
  });
});
