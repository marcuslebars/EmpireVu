/**
 * Everdoer rebrand PR 1: the forwarding-test leg key stamped into 'twilio_voice' job payloads.
 * EverdoerForwardingTestId is written only under EVERDOER_WRITE_NEW_NAMES (old
 * EmpireVuForwardingTestId otherwise); the worker reads both (new first, old counted); the
 * webhook strips BOTH from what Twilio sent, after the signature check.
 */
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";
import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

const h = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/rate-limit", () => ({ enforceWebhookBackstop: () => Promise.resolve(null) }));

import { POST as voiceInbound } from "@/app/api/twilio/voice/inbound/route";
import {
  FORWARDING_TEST_LEG_KEY,
  FORWARDING_TEST_LEG_KEYS,
  forwardingTestLegKeyForWrite,
  LEGACY_FORWARDING_TEST_LEG_KEY,
  readForwardingTestLegId,
} from "@/server/services/twilio/forwarding-test";

const TOKEN = "test-auth-token";
const BASE = "https://app.empirevu.com";
const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const TEST_ID = "33333333-3333-4333-8333-333333333333";
const CATCHER = "+17055550100";
const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "APP_BASE_URL", "TWILIO_WEBHOOK_BASE_URL", "TWILIO_FORWARDING_TEST_FROM", "EVERDOER_WRITE_NEW_NAMES"];
const saved: Record<string, string | undefined> = {};
let usage: ReturnType<typeof captureLegacyUsage>;

function sign(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}
function twilioRequest(params: Record<string, string>): Request {
  return new Request("http://internal:3000/api/twilio/voice/inbound", {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sign(`${BASE}/api/twilio/voice/inbound`, params) },
  });
}
const leg = (over: Record<string, string> = {}) => ({ CallSid: "CAleg1", From: CATCHER, To: CATCHER, CallStatus: "ringing", ...over });

beforeEach(() => {
  usage = captureLegacyUsage();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.APP_BASE_URL = BASE;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.TWILIO_FORWARDING_TEST_FROM;
  delete process.env.EVERDOER_WRITE_NEW_NAMES;
  h.db = createFakeDb({
    voice_numbers: [
      { id: "vn-1", organization_id: ORG, company_id: COMPANY, phone_e164: CATCHER, provider: "twilio", mode: "missed_call_catcher", active: true, brand_label: null },
    ],
    companies: [{ id: COMPANY, organization_id: ORG, name: "Muskoka Plumbing", slug: "muskoka-plumbing" }],
    forwarding_tests: [
      {
        id: TEST_ID,
        organization_id: ORG,
        company_id: COMPANY,
        status: "calling",
        started_at: new Date(Date.now() - 20_000).toISOString(),
        caller_id: CATCHER,
        business_line: "+17055559999",
        catcher_number: CATCHER,
      },
    ],
  });
});
afterEach(() => {
  usage.restore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("key names", () => {
  it("new + old, write follows the flag", () => {
    expect(FORWARDING_TEST_LEG_KEY).toBe("EverdoerForwardingTestId");
    expect(LEGACY_FORWARDING_TEST_LEG_KEY).toBe("EmpireVuForwardingTestId");
    expect([...FORWARDING_TEST_LEG_KEYS]).toEqual(["EverdoerForwardingTestId", "EmpireVuForwardingTestId"]);
    expect(forwardingTestLegKeyForWrite()).toBe("EmpireVuForwardingTestId");
    expect(forwardingTestLegKeyForWrite({ EVERDOER_WRITE_NEW_NAMES: "1" })).toBe("EverdoerForwardingTestId");
  });
});

describe("readForwardingTestLegId (worker)", () => {
  it("reads the new key without counting", async () => {
    expect(readForwardingTestLegId({ EverdoerForwardingTestId: "t1" })).toBe("t1");
    expect(await usage.rows()).toEqual([]);
  });
  it("reads the old key and counts it as payload_key", async () => {
    expect(readForwardingTestLegId({ EmpireVuForwardingTestId: " t2 " })).toBe("t2");
    expect(await usage.rows()).toEqual([{ kind: "payload_key", key: "EmpireVuForwardingTestId", sample: null, count: 1 }]);
  });
  it("new wins when both are present; nothing counted", async () => {
    expect(readForwardingTestLegId({ EverdoerForwardingTestId: "new", EmpireVuForwardingTestId: "old" })).toBe("new");
    expect(await usage.rows()).toEqual([]);
  });
  it("blank / missing / non-object → null", () => {
    expect(readForwardingTestLegId({ EverdoerForwardingTestId: "  " })).toBeNull();
    expect(readForwardingTestLegId({})).toBeNull();
    expect(readForwardingTestLegId(null)).toBeNull();
    expect(readForwardingTestLegId("x")).toBeNull();
  });
});

describe("voice inbound webhook", () => {
  it("flag off: stamps the OLD key (a rolled-back worker can still read it)", async () => {
    await voiceInbound(twilioRequest(leg()));
    const payload = h.db!.tables.inbound_webhook_jobs[0].payload as Record<string, unknown>;
    expect(payload.EmpireVuForwardingTestId).toBe(TEST_ID);
    expect(payload).not.toHaveProperty("EverdoerForwardingTestId");
  });

  it("flag on: stamps the NEW key only", async () => {
    process.env.EVERDOER_WRITE_NEW_NAMES = "1";
    await voiceInbound(twilioRequest(leg()));
    const payload = h.db!.tables.inbound_webhook_jobs[0].payload as Record<string, unknown>;
    expect(payload.EverdoerForwardingTestId).toBe(TEST_ID);
    expect(payload).not.toHaveProperty("EmpireVuForwardingTestId");
  });

  it("strips incoming copies of BOTH names (Twilio params can't set our flag), under either flag value", async () => {
    for (const flag of [undefined, "1"]) {
      if (flag) process.env.EVERDOER_WRITE_NEW_NAMES = flag;
      h.db!.tables.inbound_webhook_jobs = [];
      const params = leg({ CallSid: `CAcust${flag ?? "0"}`, From: "+16475550123", EmpireVuForwardingTestId: TEST_ID, EverdoerForwardingTestId: TEST_ID });
      const res = await voiceInbound(twilioRequest(params));
      expect(res.status).toBe(200);
      const payload = h.db!.tables.inbound_webhook_jobs[0].payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty("EmpireVuForwardingTestId");
      expect(payload).not.toHaveProperty("EverdoerForwardingTestId");
    }
  });
});
