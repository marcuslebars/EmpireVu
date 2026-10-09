import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

// "AI answers when you can't" — the catcher voice route + the <Dial> action route
// (docs/front-desk-ai.md → "## Phone answering"). Retell + Twilio are mocked: Twilio by signing
// requests ourselves, Retell's register-phone-call by stubbing fetch.
const h = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/rate-limit", () => ({ enforceWebhookBackstop: () => Promise.resolve(null) }));

import { POST as aiHandoff } from "@/app/api/twilio/voice/ai-handoff/route";
import { POST as voiceInbound } from "@/app/api/twilio/voice/inbound/route";
import { verifyAnswerToken } from "@/server/services/voice/ai-answer";

const AUTH_TOKEN = "test-auth-token";
const BASE = "https://app.crankleads.test";
const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_COMPANY = "44444444-4444-4444-8444-444444444444";
const CATCHER = "+17055550100";
const SECRET = "fn-secret";

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

function sign(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", AUTH_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

function twilioRequest(pathWithQuery: string, params: Record<string, string>): Request {
  return new Request(`http://internal:3000${pathWithQuery}`, {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sign(`${BASE}${pathWithQuery}`, params) },
  });
}

const callParams = (over: Record<string, string> = {}) => ({
  CallSid: "CA0001",
  AccountSid: "AC123",
  From: "+17055550123",
  To: CATCHER,
  ForwardedFrom: "+17055559999",
  CallStatus: "ringing",
  Direction: "inbound",
  ...over,
});

interface SeedOptions {
  brand?: string;
  tier?: string | null;
  plan?: string;
  aiSettings?: Record<string, unknown>;
  usedMinutes?: number;
  missedCalls?: Array<Record<string, unknown>>;
}

function seedDb(o: SeedOptions = {}): FakeDb {
  return createFakeDb({
    voice_numbers: [
      { id: "vn-1", organization_id: ORG, company_id: COMPANY, phone_e164: CATCHER, provider: "twilio", mode: "missed_call_catcher", active: true, brand_label: null },
    ],
    companies: [
      {
        id: COMPANY,
        organization_id: ORG,
        name: "Northshore Plumbing",
        slug: "northshore",
        hours: { summary: "Mon–Fri 8–5" },
        service_area: "Barrie and Orillia",
        quote_public_base_url: "https://quotes.northshore.test",
        industry_pack: { id: "hvac-plumbing", version: 1 },
        timezone: "America/Toronto",
        ai_settings: o.aiSettings ?? {},
        online_booking_settings: {},
      },
    ],
    organizations: [
      {
        id: ORG,
        plan: o.plan ?? "operate",
        subscription_status: "active",
        trial_ends_at: null,
        platform_brand: o.brand ?? "crankleads",
        crankleads_tier: o.tier === undefined ? "catch" : o.tier,
      },
    ],
    subscriptions: [],
    feature_flags: [],
    usage_monthly_v: o.usedMinutes
      ? [{ organization_id: ORG, company_id: COMPANY, month: currentMonth(), kind: "voice_minutes", quantity: o.usedMinutes }]
      : [],
    missed_calls: o.missedCalls ?? [],
  });
}

function currentMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-01`;
}

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.APP_BASE_URL = BASE;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.MISSED_CALL_TRANSCRIBE;
  delete process.env.MISSED_CALL_VOICEMAIL_MAX_SECONDS;
  delete process.env.TWILIO_SAY_VOICE;
  delete process.env.VOICE_AI_TOKEN_SECRET;
  process.env.RETELL_INTAKE_ENABLED = "1";
  process.env.RETELL_API_KEY = "key_test";
  process.env.RETELL_MESSAGE_AGENT_ID = "agent_message";
  process.env.RETELL_FUNCTION_SECRET = SECRET;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ call_id: "call_abc123" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  h.db = seedDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const db = (): FakeDb => h.db!;
const golden = () => fs.readFileSync(path.join(__dirname, "__fixtures__", "missed-call-greeting.twiml.xml"), "utf8").trim().replace("Muskoka Plumbing &amp; Heating", "Northshore Plumbing");
const registerBody = () => JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;

describe("catcher → AI (mode 'ai', the CrankLeads default)", () => {
  it("persists first, claims the call, registers it with Retell and dials the AI over SIP", async () => {
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        `<Dial action="${BASE}/api/twilio/voice/ai-handoff?event=dial" method="POST" timeout="12" timeLimit="900" answerOnBridge="true">` +
        "<Sip>sip:call_abc123@sip.retellai.com</Sip></Dial></Response>",
    );
    // Durable-first is unchanged: the queue write is still the very first DB op.
    expect(db().ops[0]).toMatchObject({ table: "inbound_webhook_jobs", op: "upsert" });
    // The call row is claimed for the AI → the worker will NOT send the generic text-back.
    expect(db().tables.missed_calls[0]).toMatchObject({
      call_sid: "CA0001",
      organization_id: ORG,
      company_id: COMPANY,
      text_back_status: "ai_pending",
      ai_retell_call_id: "call_abc123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.retellai.com/v2/register-phone-call");
    const body = registerBody();
    expect(body).toMatchObject({ agent_id: "agent_message", direction: "inbound", from_number: "+17055550123", to_number: CATCHER });
    expect(body.retell_llm_dynamic_variables).toMatchObject({
      company_name: "Northshore Plumbing",
      hours_text: "Mon–Fri 8–5",
      service_area: "Barrie and Orillia",
      booking_link: `https://quotes.northshore.test/book/${COMPANY}`,
      has_booking_link: "yes",
      business_type: "HVAC & plumbing",
    });
    const metadata = body.metadata as Record<string, string>;
    expect(metadata).toMatchObject({ source: "catcher_ai", organization_id: ORG, company_id: COMPANY, twilio_call_sid: "CA0001", agent_kind: "message" });
    expect(verifyAnswerToken({ organizationId: ORG, companyId: COMPANY, callSid: "CA0001" }, metadata.token, SECRET)).toBe(true);
  });

  it("the tenant comes from the CALLED number only — caller-supplied fields can't pick another company", async () => {
    const params = callParams({ organization_id: OTHER_ORG, company_id: OTHER_COMPANY, CallerName: "Company B please" });
    await voiceInbound(twilioRequest("/api/twilio/voice/inbound", params));
    const metadata = registerBody().metadata as Record<string, string>;
    expect(metadata.organization_id).toBe(ORG);
    expect(metadata.company_id).toBe(COMPANY);
    // A token for another tenant never verifies against this call's.
    expect(verifyAnswerToken({ organizationId: OTHER_ORG, companyId: OTHER_COMPANY, callSid: "CA0001" }, metadata.token, SECRET)).toBe(false);
  });

  it("caps the AI call at the minutes left this month", async () => {
    h.db = seedDb({ usedMinutes: 97 });
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toContain('timeLimit="180"');
  });

  it("Front Desk with its own receptionist agent → that agent (full receptionist), not the message agent", async () => {
    h.db = seedDb({ tier: "front_desk", plan: "front_desk" });
    db().tables.voice_numbers.push({ id: "vn-2", organization_id: ORG, company_id: COMPANY, phone_e164: "+17055550199", provider: "retell", provider_agent_id: "agent_fd", active: true });
    await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    expect(registerBody()).toMatchObject({ agent_id: "agent_fd", metadata: { agent_kind: "receptionist" } });
  });
});

describe("catcher → voicemail", () => {
  it("mode 'voicemail' → the existing greeting + <Record>, no Retell call, no claim", async () => {
    h.db = seedDb({ aiSettings: { call_answering: { mode: "voicemail" } } });
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toBe(golden());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().tables.missed_calls).toHaveLength(0);
  });

  it("minutes used up → voicemail + ONE owner notice queued for civil hours", async () => {
    h.db = seedDb({ usedMinutes: 100 });
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toBe(golden());
    expect(fetchMock).not.toHaveBeenCalled();
    await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams({ CallSid: "CA0002" })));
    const notices = db().tables.inbound_webhook_jobs.filter((j) => j.provider === "twilio_voice_ai");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ external_id: `minutes:${COMPANY}:${currentMonth()}`, payload: { kind: "minutes_notice", companyId: COMPANY } });
    expect(typeof notices[0].run_at).toBe("string");
  });

  it("concurrent AI calls reserve their minutes: 20 left with one call in flight → 5 min cap; with two → voicemail, no notice", async () => {
    const inFlight = (sid: string) => ({ id: sid, organization_id: ORG, company_id: COMPANY, call_sid: sid, text_back_status: "ai_pending", ai_handoff_at: new Date().toISOString(), caller_phone_last10: "4165550000" });
    h.db = seedDb({ usedMinutes: 80, missedCalls: [inFlight("CA-a")] });
    const one = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(one).toContain('timeLimit="300"');

    h.db = seedDb({ usedMinutes: 80, missedCalls: [inFlight("CA-a"), inFlight("CA-b")] });
    fetchMock.mockClear();
    const two = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(two).toBe(golden());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().tables.inbound_webhook_jobs.filter((j) => j.provider === "twilio_voice_ai")).toHaveLength(0);
  });

  it("one caller gets the AI at most 3 times a day, then voicemail", async () => {
    const earlier = (sid: string) => ({ id: sid, organization_id: ORG, company_id: COMPANY, call_sid: sid, text_back_status: "ai_handled", ai_handoff_at: new Date(Date.now() - 3_600_000).toISOString(), caller_phone_last10: "7055550123" });
    h.db = seedDb({ missedCalls: [earlier("CA-1"), earlier("CA-2"), earlier("CA-3")] });
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toBe(golden());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a house (non-CrankLeads) org is unchanged: voicemail, no Retell", async () => {
    h.db = seedDb({ brand: "empirevu", tier: null, plan: "internal" });
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toBe(golden());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("…unless its ai_settings turn AI answering on", async () => {
    h.db = seedDb({ brand: "empirevu", tier: null, plan: "internal", aiSettings: { call_answering: { mode: "ai" } } });
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toContain("<Sip>sip:call_abc123@sip.retellai.com</Sip>");
  });

  it("Retell registration fails → voicemail, and the call is released to the normal text-back path", async () => {
    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toBe(golden());
    expect(db().tables.missed_calls[0]).toMatchObject({ text_back_status: "pending" });
    expect(db().tables.missed_calls[0].ai_released_at).toBeTruthy();
    expect(db().tables.inbound_webhook_jobs.map((j) => j.external_id)).toEqual(["CA0001", "release:CA0001"]);
  });

  it("Retell not configured (kill switch off) → voicemail", async () => {
    process.env.RETELL_INTAKE_ENABLED = "0";
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toBe(golden());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the worker already processed this call (text-back out) → no AI on top", async () => {
    h.db = seedDb({ missedCalls: [{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "emitted" }] });
    const xml = await (await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()))).text();
    expect(xml).toBe(golden());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/twilio/voice/ai-handoff (the <Dial> action)", () => {
  const dialParams = (status: string) => ({ ...callParams(), DialCallStatus: status, DialSipResponseCode: status === "completed" ? "200" : "480" });

  it("rejects a bad signature", async () => {
    const req = new Request(`http://internal:3000/api/twilio/voice/ai-handoff?event=dial`, {
      method: "POST",
      body: new URLSearchParams(dialParams("completed")).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "bad" },
    });
    expect((await aiHandoff(req)).status).toBe(403);
  });

  it("completed → hang up (the AI handled it; the post-call does the rest)", async () => {
    h.db = seedDb({ missedCalls: [{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "ai_pending" }] });
    const xml = await (await aiHandoff(twilioRequest("/api/twilio/voice/ai-handoff?event=dial", dialParams("completed")))).text();
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(db().tables.missed_calls[0].text_back_status).toBe("ai_pending");
    expect(db().tables.inbound_webhook_jobs ?? []).toHaveLength(0);
  });

  it.each(["no-answer", "failed", "busy"])("%s → voicemail greeting + release (normal text-back) exactly once", async (status) => {
    const original = callParams();
    h.db = seedDb({
      missedCalls: [{ id: "mc-1", call_sid: "CA0001", organization_id: ORG, company_id: COMPANY, text_back_status: "ai_pending", raw_payload: original }],
    });
    const xml = await (await aiHandoff(twilioRequest("/api/twilio/voice/ai-handoff?event=dial", dialParams(status)))).text();
    expect(xml).toBe(golden());
    expect(db().tables.missed_calls[0].text_back_status).toBe("pending");
    const jobs = db().tables.inbound_webhook_jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ provider: "twilio_voice", external_id: "release:CA0001", payload: original });
    // A second callback can't release (or text) twice.
    await aiHandoff(twilioRequest("/api/twilio/voice/ai-handoff?event=dial", dialParams(status)));
    expect(db().tables.inbound_webhook_jobs).toHaveLength(1);
  });
});
