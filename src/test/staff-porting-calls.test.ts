/**
 * Keep your number: calls and texts to a PORTED business line (voice_numbers mode business_line)
 * ring the owner first, then fall through to the existing catcher path — and the catcher and
 * forwarding paths themselves are unchanged. Real routes, signed requests, in-memory fake DB.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown } }));
const createContact = vi.fn((..._a: unknown[]) => Promise.resolve({ id: "c-new", company_id: "co-1", phone: "+17055550123", sms_opt_out_at: null }));
const runSmsAgentForInbound = vi.fn((..._a: unknown[]) => Promise.resolve({ replied: false }));
const handleOwnerInboundSms = vi.fn((..._a: unknown[]) => Promise.resolve({ handled: true }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db.client }));
vi.mock("@/server/services/rate-limit", () => ({ enforceWebhookBackstop: () => Promise.resolve(null) }));
vi.mock("@/server/services/contacts", () => ({ createContact: (...a: unknown[]) => createContact(...a) }));
vi.mock("@/server/services/activity-events", () => ({ createActivityEvent: vi.fn(() => Promise.resolve({ id: "evt-1" })) }));
vi.mock("@/server/services/workflow-engine/dispatch", () => ({ emitActivityEventAndDispatch: vi.fn(() => Promise.resolve({ activityEvent: { id: "e" }, workflowEventJob: null })) }));
vi.mock("@/server/services/usage", () => ({ recordUsageSafe: vi.fn(), recordAiUsageSafe: vi.fn() }));
vi.mock("@/server/outbound/sms", () => ({ sendSms: vi.fn(() => Promise.resolve({ sid: "SMout" })) }));
vi.mock("@/server/services/sms-agent/entry", () => ({ runSmsAgentForInbound: (...a: unknown[]) => runSmsAgentForInbound(...a) }));
vi.mock("@/server/services/owner-channel/entry", () => ({ handleOwnerInboundSms: (...a: unknown[]) => handleOwnerInboundSms(...a) }));

import { POST as businessLine } from "@/app/api/twilio/voice/business-line/route";
import { POST as voiceInbound } from "@/app/api/twilio/voice/inbound/route";
import { ringTargets, wasAnswered } from "@/server/services/staff/porting/business-line";
import { handleInboundSms } from "@/server/services/twilio/inbound-sms";
import { resolveCatcherTenant } from "@/server/services/twilio/missed-call";

const AUTH_TOKEN = "test-auth-token";
const BASE = "https://app.crankleads.test";
const ORG = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const CATCHER = "+17055550100";
const LINE = "+17055550142";
const OWNER = "+17055559999";
const CREW = "+17055558888";
const CALLER = "+17055550123";
const SID = "CA0123456789abcdef0123456789abcdef";

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

let db: FakeDb;

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function twilioRequest(pathWithQuery: string, params: Record<string, string>, signature?: string): Request {
  return new Request(`http://internal:3000${pathWithQuery}`, {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature ?? sign(`${BASE}${pathWithQuery}`, params) },
  });
}

const call = (over: Record<string, string> = {}) => ({ CallSid: SID, AccountSid: "AC1", From: CALLER, To: LINE, CallStatus: "ringing", Direction: "inbound", ...over });

function seed(opts: { ownerPhone?: string | null; porting?: Record<string, unknown> } = {}) {
  db = createFakeDb(
    {
      voice_numbers: [
        { id: "vn-c", organization_id: ORG, company_id: CO, phone_e164: CATCHER, provider: "twilio", mode: "missed_call_catcher", active: true, brand_label: null },
        { id: "vn-l", organization_id: ORG, company_id: CO, phone_e164: LINE, provider: "twilio", mode: "business_line", active: true, brand_label: "Northshore Plumbing" },
      ],
      companies: [
        {
          id: CO,
          organization_id: ORG,
          name: "Northshore Plumbing",
          slug: "northshore-plumbing",
          timezone: "America/Toronto",
          owner_phone_e164: opts.ownerPhone === undefined ? OWNER : opts.ownerPhone,
          owner_phone_verified_at: "2026-10-01T00:00:00Z",
          brand_from_name: null,
          ai_settings: { call_answering: { mode: "voicemail" }, ...(opts.porting ? { porting: opts.porting } : {}) },
        },
      ],
      organizations: [{ id: ORG, platform_brand: "crankleads" }],
      organization_memberships: [
        { organization_id: ORG, profile_id: "p-owner", phone_e164: OWNER },
        { organization_id: ORG, profile_id: "p-crew", phone_e164: CREW },
        { organization_id: ORG, profile_id: "p-none", phone_e164: null },
      ],
      business_line_calls: [],
      inbound_webhook_jobs: [],
      contacts: [],
      message_log: [],
      platform_sms_opt_outs: [],
      owner_command_log: [],
    },
    { business_line_calls: [["call_sid"]], inbound_webhook_jobs: [["provider", "external_id"]] },
  );
  h.db = db as unknown as { client: unknown };
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.APP_BASE_URL = BASE;
  process.env.TWILIO_FROM_NUMBER = "+16475550000";
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.MISSED_CALL_TRANSCRIBE;
  delete process.env.MISSED_CALL_VOICEMAIL_MAX_SECONDS;
  delete process.env.TWILIO_SAY_VOICE;
  delete process.env.RETELL_INTAKE_ENABLED;
  runSmsAgentForInbound.mockClear();
  seed();
});

const BL = "/api/twilio/voice/business-line";
const FALL_THROUGH = `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">${BASE}/api/twilio/voice/inbound</Redirect></Response>`;

describe("a call to a ported business line", () => {
  it("rejects a bad signature (403) and does nothing", async () => {
    const res = await businessLine(twilioRequest(BL, call(), "bm90LXRoZS1zaWduYXR1cmU="));
    expect(res.status).toBe(403);
    expect(db.tables.business_line_calls).toHaveLength(0);
  });

  it("rings the owner's cell first (20 s, screened, caller's number shown) and queues NO missed call yet", async () => {
    const res = await businessLine(twilioRequest(BL, call()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="${BASE}${BL}?stage=after" method="POST" timeout="20" answerOnBridge="true" callerId="${CALLER}">` +
        `<Number url="${BASE}${BL}?stage=screen&amp;parent=${SID}" method="POST">${OWNER}</Number></Dial></Response>`,
    );
    expect(db.tables.business_line_calls).toEqual([expect.objectContaining({ organization_id: ORG, company_id: CO, call_sid: SID, business_line: LINE, rang: [OWNER], screen: true })]);
    expect(db.tables.inbound_webhook_jobs).toHaveLength(0);
  });

  it("rings crew cells too when set (owner first, no duplicates), for the set seconds, unscreened when off", async () => {
    seed({ porting: { ring: { crew: true, seconds: 15, screen: false } } });
    const xml = await (await businessLine(twilioRequest(BL, call()))).text();
    expect(xml).toContain('timeout="15"');
    expect(xml).toContain(`<Number>${OWNER}</Number><Number>${CREW}</Number></Dial>`);
    expect(xml).not.toContain("stage=screen");
  });

  it("never rings one of our own numbers (an owner 'cell' that IS the ported line) → straight to the catcher path", async () => {
    seed({ ownerPhone: LINE });
    expect(await (await businessLine(twilioRequest(BL, call()))).text()).toBe(FALL_THROUGH);
    expect(ringTargets({ ownerPhone: CATCHER, crewPhones: [CREW, CREW, "junk"], crew: true, exclude: new Set([CATCHER]) })).toEqual([CREW]);
  });

  it("ring off, no owner cell, or a number that isn't a business line → the catcher path", async () => {
    seed({ porting: { ring: { enabled: false } } });
    expect(await (await businessLine(twilioRequest(BL, call()))).text()).toBe(FALL_THROUGH);
    seed({ ownerPhone: null });
    expect(await (await businessLine(twilioRequest(BL, call()))).text()).toBe(FALL_THROUGH);
    seed();
    expect(await (await businessLine(twilioRequest(BL, call({ To: CATCHER })))).text()).toBe(FALL_THROUGH);
  });

  it("screening: the owner hears the business name; 1 bridges (recorded), anything else drops only their leg", async () => {
    await businessLine(twilioRequest(BL, call()));
    const leg = { CallSid: "CA_child_leg_1", ParentCallSid: SID, From: CALLER, To: OWNER };
    const screen = await (await businessLine(twilioRequest(`${BL}?stage=screen&parent=${SID}`, leg))).text();
    expect(screen).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="${BASE}${BL}?stage=screened&amp;parent=${SID}" method="POST">` +
        `<Say voice="Polly.Joanna">Call for Northshore Plumbing. Press 1 to take it.</Say></Gather><Hangup/></Response>`,
    );
    expect(await (await businessLine(twilioRequest(`${BL}?stage=screened&parent=${SID}`, { ...leg, Digits: "2" }))).text()).toContain("<Hangup/>");
    expect(db.tables.business_line_calls[0].accepted_at ?? null).toBeNull();
    expect(await (await businessLine(twilioRequest(`${BL}?stage=screened&parent=${SID}`, { ...leg, Digits: "1" }))).text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(db.tables.business_line_calls[0].accepted_at).toBeTruthy();
  });

  it("answered (pressed 1) → hang up when they're done; nothing queued", async () => {
    await businessLine(twilioRequest(BL, call()));
    await businessLine(twilioRequest(`${BL}?stage=screened&parent=${SID}`, { CallSid: "CA_child_leg_1", Digits: "1" }));
    const res = await businessLine(twilioRequest(`${BL}?stage=after`, call({ DialCallStatus: "completed", DialCallDuration: "42" })));
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(db.tables.business_line_calls[0].outcome).toBe("answered");
    expect(db.tables.inbound_webhook_jobs).toHaveLength(0);
  });

  it("the cell's voicemail picked up (completed, nobody pressed 1), no answer, or busy → the catcher path", async () => {
    await businessLine(twilioRequest(BL, call()));
    expect(await (await businessLine(twilioRequest(`${BL}?stage=after`, call({ DialCallStatus: "completed" })))).text()).toBe(FALL_THROUGH);
    expect(db.tables.business_line_calls[0].outcome).toBe("missed");
    for (const status of ["no-answer", "busy", "failed", "canceled"]) {
      expect(await (await businessLine(twilioRequest(`${BL}?stage=after`, call({ DialCallStatus: status })))).text()).toBe(FALL_THROUGH);
    }
    expect(wasAnswered({ dialCallStatus: "completed", dialBridged: null, call: { screen: false, accepted_at: null } })).toBe(true);
    expect(wasAnswered({ dialCallStatus: "completed", dialBridged: "false", call: { screen: false, accepted_at: null } })).toBe(false);
    expect(wasAnswered({ dialCallStatus: "completed", dialBridged: null, call: null })).toBe(false);
  });

  it("the redirected call takes the existing catcher path on the inbound route: durable job + the company's greeting", async () => {
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", call({ CallStatus: "in-progress" })));
    expect(res.status).toBe(200);
    expect(db.tables.inbound_webhook_jobs).toEqual([expect.objectContaining({ provider: "twilio_voice", external_id: SID, status: "pending" })]);
    const xml = await res.text();
    expect(xml).toContain("This is Northshore Plumbing.");
    expect(xml).toContain("<Record ");
    // The worker resolves the same tenant from the ported line.
    expect(await resolveCatcherTenant(db.client as never, LINE)).toMatchObject({ organizationId: ORG, companyId: CO, companyName: "Northshore Plumbing", phoneE164: LINE });
  });
});

describe("the catcher and forwarding paths are unchanged", () => {
  it("a forwarded call to the catcher number never rings the owner: golden greeting TwiML, durable job first", async () => {
    const params = { CallSid: "CA0001", AccountSid: "AC123", From: CALLER, To: CATCHER, ForwardedFrom: "+17055559999", CallStatus: "ringing", Direction: "inbound" };
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", params));
    const golden = fs
      .readFileSync(path.join(__dirname, "__fixtures__", "missed-call-greeting.twiml.xml"), "utf8")
      .trim()
      .replace("Muskoka Plumbing &amp; Heating", "Northshore Plumbing");
    expect(await res.text()).toBe(golden);
    expect(db.queries[0]).toMatchObject({ table: "inbound_webhook_jobs", op: "upsert" });
    expect(db.tables.business_line_calls).toHaveLength(0);
    expect(await resolveCatcherTenant(db.client as never, CATCHER)).toMatchObject({ companyId: CO, phoneE164: CATCHER });
  });

  it("an inactive or unknown number still resolves to no tenant", async () => {
    db.tables.voice_numbers[1].active = false;
    expect(await resolveCatcherTenant(db.client as never, LINE)).toBeNull();
    expect(await resolveCatcherTenant(db.client as never, "+16475551234")).toBeNull();
  });

  it("a forwarding-test leg from our own caller id to the catcher still just hangs up", async () => {
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", { CallSid: "CA0002", From: CATCHER, To: CATCHER, CallStatus: "ringing" }));
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
});

describe("texts to the ported line", () => {
  it("route to the company exactly like the catcher number (contact → SMS agent)", async () => {
    await handleInboundSms({ From: CALLER, To: LINE, Body: "Do you do drain cleaning?", MessageSid: "SM1" });
    expect(runSmsAgentForInbound).toHaveBeenCalledWith(db.client, expect.objectContaining({ organizationId: ORG, companyId: CO, body: "Do you do drain cleaning?" }));
  });
});
