import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";

// The admin client both routes use → an in-memory DB we can inspect.
const h = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/rate-limit", () => ({ enforceWebhookBackstop: () => Promise.resolve(null) }));

import { POST as voiceInbound } from "@/app/api/twilio/voice/inbound/route";
import { POST as voiceRecording } from "@/app/api/twilio/voice/recording/route";

const AUTH_TOKEN = "test-auth-token";
const BASE = "https://app.crankleads.test";
const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const CATCHER = "+17055550100";

const env = { ...process.env };
afterAll(() => {
  process.env = env;
});

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function twilioRequest(pathWithQuery: string, params: Record<string, string>, signature?: string): Request {
  // The request arrives on an internal host (proxy) — the route must verify against the
  // PUBLIC url (APP_BASE_URL + path + query), which is what Twilio signed.
  const publicUrl = `${BASE}${pathWithQuery}`;
  return new Request(`http://internal:3000${pathWithQuery}`, {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? sign(publicUrl, params),
    },
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

function seedDb(): FakeDb {
  return createFakeDb({
    voice_numbers: [
      {
        id: "vn-1",
        organization_id: ORG,
        company_id: COMPANY,
        phone_e164: CATCHER,
        provider: "twilio",
        mode: "missed_call_catcher",
        active: true,
        brand_label: null,
      },
    ],
    companies: [{ id: COMPANY, organization_id: ORG, name: "Muskoka Plumbing & Heating", slug: "muskoka-plumbing" }],
  });
}

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.APP_BASE_URL = BASE;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.MISSED_CALL_TRANSCRIBE;
  delete process.env.MISSED_CALL_VOICEMAIL_MAX_SECONDS;
  delete process.env.TWILIO_SAY_VOICE;
  h.db = seedDb();
});

const db = (): FakeDb => h.db!;

describe("POST /api/twilio/voice/inbound", () => {
  it("rejects a bad signature with 403 and persists nothing", async () => {
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams(), "bm90LXRoZS1zaWduYXR1cmU="));
    expect(res.status).toBe(403);
    expect(db().ops).toHaveLength(0);
  });

  it("rejects a request signed with a different auth token", async () => {
    const params = callParams();
    const res = await voiceInbound(
      twilioRequest("/api/twilio/voice/inbound", params, sign(`${BASE}/api/twilio/voice/inbound`, params, "other-token")),
    );
    expect(res.status).toBe(403);
    expect(db().tables.inbound_webhook_jobs ?? []).toHaveLength(0);
  });

  it("persists the raw webhook BEFORE resolving the tenant, then answers with the golden TwiML", async () => {
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");

    // Durable-first: the very first DB operation is the queue write.
    expect(db().ops[0]).toMatchObject({ table: "inbound_webhook_jobs", op: "upsert" });
    expect(db().ops.findIndex((o) => o.table === "voice_numbers")).toBeGreaterThan(0);
    const job = db().tables.inbound_webhook_jobs[0];
    expect(job).toMatchObject({ provider: "twilio_voice", external_id: "CA0001", status: "pending" });
    expect(job.payload).toMatchObject({ From: "+17055550123", To: CATCHER, ForwardedFrom: "+17055559999" });

    const golden = fs.readFileSync(path.join(__dirname, "__fixtures__", "missed-call-greeting.twiml.xml"), "utf8").trim();
    expect(await res.text()).toBe(golden);
  });

  it("a redelivered CallSid is a no-op enqueue (one job)", async () => {
    await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    expect(db().tables.inbound_webhook_jobs).toHaveLength(1);
  });

  it("unknown called number → stored + 200 empty <Response/> (no crash)", async () => {
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams({ To: "+16475550000" })));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(db().tables.inbound_webhook_jobs).toHaveLength(1);
  });

  it("returns 500 (and no TwiML) when the durable write fails", async () => {
    db().failNext("inbound_webhook_jobs", { message: "db down" });
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    expect(res.status).toBe(500);
  });

  it("still greets (generically) and records when the tenant lookup errors after the durable write", async () => {
    db().failNext("voice_numbers", { message: "timeout" });
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("Sorry we missed your call. We&apos;ll text you right away.");
    expect(xml).toContain("<Record ");
    expect(db().tables.inbound_webhook_jobs).toHaveLength(1);
  });

  it("adds transcription to the <Record> when MISSED_CALL_TRANSCRIBE=true", async () => {
    process.env.MISSED_CALL_TRANSCRIBE = "true";
    const res = await voiceInbound(twilioRequest("/api/twilio/voice/inbound", callParams()));
    expect(await res.text()).toContain(
      `transcribe="true" transcribeCallback="${BASE}/api/twilio/voice/recording?event=transcription"`,
    );
  });
});

describe("POST /api/twilio/voice/recording", () => {
  const recParams = (over: Record<string, string> = {}) => ({
    CallSid: "CA0001",
    AccountSid: "AC123",
    RecordingSid: "RE0001",
    RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE0001",
    RecordingDuration: "14",
    ...over,
  });

  it("rejects a bad signature", async () => {
    const res = await voiceRecording(twilioRequest("/api/twilio/voice/recording?event=status", recParams(), "bad"));
    expect(res.status).toBe(403);
    expect(db().ops).toHaveLength(0);
  });

  it("the <Record> action enqueues the voicemail and says goodbye; the status callback for the same RecordingSid is a no-op", async () => {
    const action = await voiceRecording(twilioRequest("/api/twilio/voice/recording?event=action", recParams()));
    expect(action.status).toBe(200);
    expect(await action.text()).toContain("<Hangup/>");

    const status = await voiceRecording(
      twilioRequest("/api/twilio/voice/recording?event=status", recParams({ RecordingStatus: "completed" })),
    );
    expect(status.status).toBe(200);
    expect(await status.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    expect(db().tables.inbound_webhook_jobs).toHaveLength(1);
    expect(db().tables.inbound_webhook_jobs[0]).toMatchObject({
      provider: "twilio_voicemail",
      external_id: "recording:RE0001",
    });
  });

  it("keys a transcription callback by its TranscriptionSid", async () => {
    await voiceRecording(
      twilioRequest(
        "/api/twilio/voice/recording?event=transcription",
        recParams({ TranscriptionSid: "TR0001", TranscriptionText: "Hi it's Bob", TranscriptionStatus: "completed" }),
      ),
    );
    expect(db().tables.inbound_webhook_jobs[0]).toMatchObject({ external_id: "transcription:TR0001" });
  });

  it("a status callback whose durable write fails returns 500", async () => {
    db().failNext("inbound_webhook_jobs", { message: "db down" });
    const res = await voiceRecording(twilioRequest("/api/twilio/voice/recording?event=status", recParams()));
    expect(res.status).toBe(500);
  });
});
