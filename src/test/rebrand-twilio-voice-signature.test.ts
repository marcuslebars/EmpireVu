/**
 * Everdoer rebrand PR 1: Twilio VOICE signatures are checked against a candidate URL list
 * (configured base, arriving host, the platform's old + new hosts), like inbound SMS, so a
 * number still configured with an old host keeps working after APP_BASE_URL changes. Every
 * candidate still needs a valid HMAC under TWILIO_AUTH_TOKEN.
 */
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "./fake-supabase";
import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

const h = vi.hoisted(() => ({ db: null as FakeDb | null }));
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => h.db?.client }));
vi.mock("@/server/services/rate-limit", () => ({ enforceWebhookBackstop: () => Promise.resolve(null) }));

import { POST as voiceInbound } from "@/app/api/twilio/voice/inbound/route";
import { POST as voiceRecording } from "@/app/api/twilio/voice/recording/route";
import { twilioVoiceUrlCandidates, verifyTwilioVoiceSignature } from "@/server/services/twilio/voice-signature";

const TOKEN = "test-auth-token";
const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "APP_BASE_URL", "TWILIO_WEBHOOK_BASE_URL"];
const saved: Record<string, string | undefined> = {};
let usage: ReturnType<typeof captureLegacyUsage>;

function sign(url: string, params: Record<string, string>, token = TOKEN): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

/** Arrives on the internal proxy host, as in production. */
function arriving(pathWithQuery: string, params: Record<string, string>, signature: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://internal:3000${pathWithQuery}`, {
    method: "POST",
    body: new URLSearchParams(params).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature, ...headers },
  });
}

const PARAMS = { CallSid: "CA1", From: "+17055550123", To: "+17055550100", CallStatus: "ringing" };

beforeEach(() => {
  usage = captureLegacyUsage();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.APP_BASE_URL = "https://app.everdoer.com";
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  h.db = createFakeDb({ voice_numbers: [], companies: [] });
});
afterEach(() => {
  usage.restore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("twilioVoiceUrlCandidates", () => {
  it("configured base first, then the arriving host, then the platform hosts; same path + query on each", () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://app.empirevu.com/";
    const req = arriving("/api/twilio/voice/recording?event=status", PARAMS, "x", { "x-forwarded-host": "api.empirevu.com, internal" });
    expect(twilioVoiceUrlCandidates(req)).toEqual([
      "https://app.empirevu.com/api/twilio/voice/recording?event=status",
      "https://api.empirevu.com/api/twilio/voice/recording?event=status",
      "https://app.crankleads.com/api/twilio/voice/recording?event=status",
      "https://app.everdoer.com/api/twilio/voice/recording?event=status",
      "https://api.everdoer.com/api/twilio/voice/recording?event=status",
    ]);
  });

  it("never includes the internal request.url when a base is configured, and nothing outside the list", () => {
    const req = arriving("/api/twilio/voice/inbound", PARAMS, "x", { host: "app.everdoer.com" });
    const hosts = twilioVoiceUrlCandidates(req).map((u) => new URL(u).host);
    expect(hosts).not.toContain("internal:3000");
    expect(new Set(hosts)).toEqual(new Set(["app.everdoer.com", "app.empirevu.com", "api.empirevu.com", "app.crankleads.com", "api.everdoer.com"]));
  });

  it("falls back to request.url only when no base is configured (previous behaviour)", () => {
    delete process.env.APP_BASE_URL;
    const req = arriving("/api/twilio/voice/inbound", PARAMS, "x");
    expect(twilioVoiceUrlCandidates(req)).toContain("http://internal:3000/api/twilio/voice/inbound");
  });
});

describe("verifyTwilioVoiceSignature", () => {
  it("accepts a number still configured with an OLD host after APP_BASE_URL moved, and counts the host", async () => {
    const sig = sign("https://app.empirevu.com/api/twilio/voice/recording?event=status", PARAMS);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/recording?event=status", PARAMS, sig), PARAMS, sig, TOKEN)).toBe(true);
    const sig2 = sign("https://app.crankleads.com/api/twilio/voice/inbound", PARAMS);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/inbound", PARAMS, sig2), PARAMS, sig2, TOKEN)).toBe(true);
    expect(await usage.rows()).toEqual([
      { kind: "twilio_signature", key: "app.empirevu.com", sample: "/api/twilio/voice/recording", count: 1 },
      { kind: "twilio_signature", key: "app.crankleads.com", sample: "/api/twilio/voice/inbound", count: 1 },
    ]);
  });

  it("accepts the configured base and the new hosts without counting", async () => {
    const viaBase = sign("https://app.everdoer.com/api/twilio/voice/inbound", PARAMS);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/inbound", PARAMS, viaBase), PARAMS, viaBase, TOKEN)).toBe(true);
    const viaApi = sign("https://api.everdoer.com/api/twilio/voice/inbound", PARAMS);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/inbound", PARAMS, viaApi), PARAMS, viaApi, TOKEN)).toBe(true);
    expect(await usage.rows()).toEqual([]);
  });

  it("still counts when the configured base itself is an old host (TWILIO_WEBHOOK_BASE_URL pinned during the move)", async () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://api.empirevu.com";
    const sig = sign("https://api.empirevu.com/api/twilio/voice/inbound", PARAMS);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/inbound", PARAMS, sig), PARAMS, sig, TOKEN)).toBe(true);
    expect(await usage.rows()).toEqual([{ kind: "twilio_signature", key: "api.empirevu.com", sample: "/api/twilio/voice/inbound", count: 1 }]);
  });

  it("with a base configured, a client-chosen Host adds no candidate (a signature for another host is replay-proof)", async () => {
    const sig = sign("https://staging.example.net/api/twilio/voice/inbound", PARAMS);
    const req = arriving("/api/twilio/voice/inbound", PARAMS, sig, { "x-forwarded-host": "staging.example.net" });
    expect(verifyTwilioVoiceSignature(req, PARAMS, sig, TOKEN)).toBe(false);
    expect(await usage.rows()).toEqual([]);
  });

  it("with NO base configured (local dev), the arriving host is accepted as before", async () => {
    vi.stubEnv("TWILIO_WEBHOOK_BASE_URL", "");
    vi.stubEnv("APP_BASE_URL", "");
    const sig = sign("https://dev.example.net/api/twilio/voice/inbound", PARAMS);
    const req = arriving("/api/twilio/voice/inbound", PARAMS, sig, { "x-forwarded-host": "dev.example.net" });
    expect(verifyTwilioVoiceSignature(req, PARAMS, sig, TOKEN)).toBe(true);
    expect(await usage.rows()).toEqual([]);
  });

  it("rejects a host outside the list (signed for somewhere else)", () => {
    const sig = sign("https://evil.example/api/twilio/voice/inbound", PARAMS);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/inbound", PARAMS, sig), PARAMS, sig, TOKEN)).toBe(false);
  });

  it("rejects a wrong auth token, a missing token or header, tampered params and a different query", () => {
    const url = "https://app.empirevu.com/api/twilio/voice/recording?event=status";
    const bad = sign(url, PARAMS, "other-token");
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/recording?event=status", PARAMS, bad), PARAMS, bad, TOKEN)).toBe(false);
    const good = sign(url, PARAMS);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/recording?event=status", PARAMS, good), PARAMS, good, undefined)).toBe(false);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/recording?event=status", PARAMS, good), PARAMS, null, TOKEN)).toBe(false);
    const tampered = { ...PARAMS, From: "+19995550000" };
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/recording?event=status", tampered, good), tampered, good, TOKEN)).toBe(false);
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/recording?event=action", PARAMS, good), PARAMS, good, TOKEN)).toBe(false);
  });

  it("an unsigned request is never accepted, whatever the candidates", () => {
    expect(verifyTwilioVoiceSignature(arriving("/api/twilio/voice/inbound", PARAMS, ""), PARAMS, "", TOKEN)).toBe(false);
  });
});

describe("voice routes use the candidate list", () => {
  it("inbound: a call signed with the old app host is accepted after APP_BASE_URL moved to everdoer", async () => {
    const sig = sign("https://app.empirevu.com/api/twilio/voice/inbound", PARAMS);
    const res = await voiceInbound(arriving("/api/twilio/voice/inbound", PARAMS, sig));
    expect(res.status).toBe(200);
    expect(h.db!.tables.inbound_webhook_jobs).toHaveLength(1);
  });

  it("recording: a forged signature is still 403 with nothing persisted", async () => {
    const sig = sign("https://app.empirevu.com/api/twilio/voice/recording?event=status", PARAMS, "not-the-token");
    const res = await voiceRecording(arriving("/api/twilio/voice/recording?event=status", PARAMS, sig));
    expect(res.status).toBe(403);
    expect(h.db!.ops).toHaveLength(0);
  });
});
