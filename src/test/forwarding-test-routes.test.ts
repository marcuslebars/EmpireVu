/**
 * Forwarding verification — routes (docs/missed-call-catcher.md → Forwarding verification):
 *   • /api/twilio/voice/forwarding-test — signature-verified, durable-first callback route;
 *   • /api/twilio/voice/inbound — the forwarded test leg gets a bare <Hangup/>;
 *   • /api/organizations/:orgId/missed-call-catcher/forwarding-test — auth (members read,
 *     owner/admin test), validation and the 429 rate limit.
 */
import crypto from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

const h = vi.hoisted(() => ({
  db: null as FakeDb | null,
  role: "owner",
  start: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServerClient: () => h.db?.client }));
vi.mock("@/server/services/rate-limit", () => ({ enforceWebhookBackstop: () => Promise.resolve(null) }));
vi.mock("@/server/organizations/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/organizations/context")>();
  return {
    ...original,
    requireOrganizationContext: async (_s: unknown, organizationId: string) => ({
      organizationId,
      user: { id: "user-1" },
      membership: { role: h.role },
    }),
  };
});
vi.mock("@/server/services/twilio/forwarding-test", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/services/twilio/forwarding-test")>();
  return {
    ...original,
    startOwnerForwardingTest: (...args: unknown[]) => h.start(...args),
    getForwardingVerificationStatus: (...args: unknown[]) => h.status(...args),
  };
});

import { GET as orgGet, POST as orgPost } from "@/app/api/organizations/[organizationId]/missed-call-catcher/forwarding-test/route";
import { POST as callback } from "@/app/api/twilio/voice/forwarding-test/route";
import { POST as voiceInbound } from "@/app/api/twilio/voice/inbound/route";
import { FORWARDING_TEST_LEG_KEY, ForwardingTestRateLimited } from "@/server/services/twilio/forwarding-test";

const AUTH_TOKEN = "test-auth-token";
const BASE = "https://app.crankleads.test";
const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const TEST_ID = "33333333-3333-4333-8333-333333333333";
const CATCHER = "+17055550100";
const BUSINESS = "+17055559999";

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function twilioRequest(pathWithQuery: string, params: Record<string, string>, signature?: string): Request {
  return new Request(`http://internal:3000${pathWithQuery}`, {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? sign(`${BASE}${pathWithQuery}`, params),
    },
  });
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.APP_BASE_URL = BASE;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.TWILIO_FORWARDING_TEST_FROM;
  h.role = "owner";
  h.start.mockReset();
  h.status.mockReset();
  h.db = createFakeDb({
    voice_numbers: [
      { id: "vn-1", organization_id: ORG, company_id: COMPANY, phone_e164: CATCHER, provider: "twilio", mode: "missed_call_catcher", active: true, brand_label: null },
    ],
    companies: [{ id: COMPANY, organization_id: ORG, name: "Muskoka Plumbing", slug: "muskoka-plumbing" }],
    forwarding_tests: [],
  });
});

const db = (): FakeDb => h.db!;

describe("POST /api/twilio/voice/forwarding-test (Twilio callbacks)", () => {
  const path = `/api/twilio/voice/forwarding-test?testId=${TEST_ID}&event=status`;
  const params = { CallSid: "CAout1", CallStatus: "no-answer", AccountSid: "AC1" };

  it("rejects a bad signature with 403 and persists nothing", async () => {
    const res = await callback(twilioRequest(path, params, "bm90LXRoZS1zaWduYXR1cmU="));
    expect(res.status).toBe(403);
    expect(db().ops).toHaveLength(0);
  });

  it("a signature over a different testId (tampered URL) is rejected", async () => {
    const forged = sign(`${BASE}/api/twilio/voice/forwarding-test?testId=${TEST_ID}&event=status`, params);
    const res = await callback(
      twilioRequest(`/api/twilio/voice/forwarding-test?testId=44444444-4444-4444-8444-444444444444&event=status`, params, forged),
    );
    expect(res.status).toBe(403);
  });

  it("persists the callback durably (one job per call × event × status) and answers 200", async () => {
    const res = await callback(twilioRequest(path, params));
    expect(res.status).toBe(200);
    expect(db().ops[0]).toMatchObject({ table: "inbound_webhook_jobs", op: "upsert" });
    expect(db().tables.inbound_webhook_jobs[0]).toMatchObject({
      provider: "twilio_forwarding_test",
      external_id: "status:CAout1:no-answer",
      status: "pending",
      payload: { ...params, ForwardingTestId: TEST_ID, ForwardingTestEvent: "status" },
    });
    await callback(twilioRequest(path, params));
    expect(db().tables.inbound_webhook_jobs).toHaveLength(1);
  });

  it("AMD callbacks are keyed by AnsweredBy", async () => {
    const amdPath = `/api/twilio/voice/forwarding-test?testId=${TEST_ID}&event=amd`;
    await callback(twilioRequest(amdPath, { CallSid: "CAout1", AnsweredBy: "machine_start" }));
    expect(db().tables.inbound_webhook_jobs[0].external_id).toBe("amd:CAout1:machine_start");
  });

  it("an authentic callback with a bad testId / event is acknowledged but not queued", async () => {
    const bad = `/api/twilio/voice/forwarding-test?testId=nope&event=status`;
    expect((await callback(twilioRequest(bad, params))).status).toBe(200);
    const badEvent = `/api/twilio/voice/forwarding-test?testId=${TEST_ID}&event=other`;
    expect((await callback(twilioRequest(badEvent, params))).status).toBe(200);
    expect(db().tables.inbound_webhook_jobs ?? []).toHaveLength(0);
  });

  it("returns 500 when the durable write fails", async () => {
    db().failNext("inbound_webhook_jobs", { message: "db down" });
    expect((await callback(twilioRequest(path, params))).status).toBe(500);
  });
});

describe("POST /api/twilio/voice/inbound — the forwarded test leg", () => {
  const leg = (over: Record<string, string> = {}) => ({ CallSid: "CAleg1", From: CATCHER, To: CATCHER, CallStatus: "ringing", ...over });
  const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

  const inFlight = (over: Record<string, unknown> = {}) =>
    db().tables.forwarding_tests.push({
      id: TEST_ID,
      organization_id: ORG,
      company_id: COMPANY,
      status: "calling",
      started_at: new Date(Date.now() - 20_000).toISOString(),
      caller_id: CATCHER,
      business_line: BUSINESS,
      catcher_number: CATCHER,
      ...over,
    });

  it("a leg From == the test's caller ID: persisted WITH the test id flag, then a bare hang-up", async () => {
    inFlight();
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", leg()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(hangup);
    expect(db().tables.inbound_webhook_jobs[0]).toMatchObject({
      provider: "twilio_voice",
      external_id: "CAleg1",
      payload: { ...leg(), [FORWARDING_TEST_LEG_KEY]: TEST_ID },
    });
  });

  it("the platform verifier as caller ID is matched the same way", async () => {
    process.env.TWILIO_FORWARDING_TEST_FROM = "+14165550111";
    inFlight({ caller_id: "+14165550111" });
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", leg({ From: "+14165550111" })));
    expect(await res.text()).toBe(hangup);
    expect(db().tables.inbound_webhook_jobs[0].payload).toMatchObject({ [FORWARDING_TEST_LEG_KEY]: TEST_ID });
  });

  it("From == business line / ForwardedFrom == business line during a test is a CUSTOMER: greeting, no flag, no test lookup", async () => {
    inFlight();
    const res1 = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", leg({ From: BUSINESS })));
    expect(await res1.text()).toContain("<Record ");
    const res2 = await voiceInbound(
      twilioRequest("/api/twilio/voice/inbound", leg({ CallSid: "CAcust", From: "+16475550123", ForwardedFrom: BUSINESS })),
    );
    expect(await res2.text()).toContain("<Record ");
    for (const job of db().tables.inbound_webhook_jobs) {
      expect(job.payload).not.toHaveProperty(FORWARDING_TEST_LEG_KEY);
    }
    // Customer calls do no forwarding_tests I/O at all, and the durable write is the first op.
    expect(db().ops.filter((o) => o.table === "forwarding_tests")).toHaveLength(0);
    expect(db().ops[0]).toMatchObject({ table: "inbound_webhook_jobs", op: "upsert" });
  });

  it("an incoming copy of the flag key is stripped (only this route sets it)", async () => {
    const params = leg({ From: "+16475550123", [FORWARDING_TEST_LEG_KEY]: TEST_ID });
    await voiceInbound(twilioRequest("/api/twilio/voice/inbound", params));
    expect(db().tables.inbound_webhook_jobs[0].payload).not.toHaveProperty(FORWARDING_TEST_LEG_KEY);
  });

  it("a call from our own test caller ID with no test in the window hangs up, unflagged", async () => {
    inFlight({ started_at: new Date(Date.now() - 4 * 60_000).toISOString() });
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", leg()));
    expect(await res.text()).toBe(hangup);
    expect(db().tables.inbound_webhook_jobs[0].payload).not.toHaveProperty(FORWARDING_TEST_LEG_KEY);
  });

  it("a real customer still gets the greeting", async () => {
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", leg({ From: "+16475550123" })));
    expect(await res.text()).toContain("<Record ");
  });

  it("if the test lookup errors, the leg is still persisted (unflagged)", async () => {
    inFlight();
    db().failNext("forwarding_tests", { message: "relation does not exist" });
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", leg()));
    expect(res.status).toBe(200);
    expect(db().tables.inbound_webhook_jobs[0]).toMatchObject({ provider: "twilio_voice", external_id: "CAleg1" });
    expect(db().tables.inbound_webhook_jobs[0].payload).not.toHaveProperty(FORWARDING_TEST_LEG_KEY);
  });
});

describe("/api/organizations/:orgId/missed-call-catcher/forwarding-test", () => {
  const url = `https://app.test/api/organizations/${ORG}/missed-call-catcher/forwarding-test`;
  const post = (body: unknown) =>
    orgPost(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
      params: { organizationId: ORG },
    });

  it("POST: owner/admin only", async () => {
    h.role = "member";
    const res = await post({ companyId: COMPANY });
    expect(res.status).toBe(403);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("POST: starts a test in the caller's org (company from the body, org from the session)", async () => {
    h.start.mockResolvedValue({ id: TEST_ID, status: "calling" });
    const res = await post({ companyId: COMPANY });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ id: TEST_ID, status: "calling" });
    expect(h.start.mock.calls[0][0]).toMatchObject({ organizationId: ORG, actorProfileId: "user-1" });
    expect(h.start.mock.calls[0][1]).toBe(COMPANY);
  });

  it("POST: rejects a body without a valid companyId (no phone number parameter is accepted)", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ companyId: "x" })).status).toBe(400);
    h.start.mockResolvedValue({ id: TEST_ID });
    await post({ companyId: COMPANY, businessLine: "+19005551234" });
    expect(h.start.mock.calls[0]).toHaveLength(2);
  });

  it("POST: the rate limit is a 429 with Retry-After", async () => {
    h.start.mockRejectedValue(new ForwardingTestRateLimited("Please wait 60s before testing again.", 60));
    const res = await post({ companyId: COMPANY });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json()).error).toMatch(/wait 60s/);
  });

  it("GET: any member can read the status; companyId required", async () => {
    h.role = "member";
    h.status.mockResolvedValue({ hasCatcher: true, verifiedAt: null });
    const res = await orgGet(new Request(`${url}?companyId=${COMPANY}`), { params: { organizationId: ORG } });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ hasCatcher: true });
    expect((await orgGet(new Request(url), { params: { organizationId: ORG } })).status).toBe(400);
  });
});
