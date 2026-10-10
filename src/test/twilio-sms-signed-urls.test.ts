import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { inboundSmsUrlCandidates } from "@/server/services/twilio/sms-signed-urls";
import { verifyTwilioSignature } from "@/server/services/twilio/signature";

const sign = (url: string, params: Record<string, string>, token: string) =>
  crypto.createHmac("sha1", token).update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");

const ENV = ["TWILIO_INBOUND_SMS_URL", "TWILIO_WEBHOOK_BASE_URL", "APP_BASE_URL"] as const;
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

const req = (headers: Record<string, string> = {}) =>
  new Request("http://0.0.0.0:8080/api/twilio/sms/inbound", { method: "POST", headers });

describe("inbound SMS: which URLs Twilio may have signed", () => {
  it("tries the explicit URL first, then each configured base, then the public host", () => {
    process.env.TWILIO_INBOUND_SMS_URL = "https://api.empirevu.com/api/twilio/sms/inbound";
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://api.empirevu.com/";
    process.env.APP_BASE_URL = "https://app.empirevu.com";
    expect(inboundSmsUrlCandidates(req({ "x-forwarded-host": "app.empirevu.com" }))).toEqual([
      "https://api.empirevu.com/api/twilio/sms/inbound",
      "https://app.empirevu.com/api/twilio/sms/inbound",
      "http://0.0.0.0:8080/api/twilio/sms/inbound",
    ]);
  });

  it("a number pointed at app.* verifies even when TWILIO_INBOUND_SMS_URL names api.*", () => {
    process.env.TWILIO_INBOUND_SMS_URL = "https://api.empirevu.com/api/twilio/sms/inbound";
    const params = { MessageSid: "SM1", To: "+12898034824", From: "+17055550123", Body: "today" };
    const sig = sign("https://app.empirevu.com/api/twilio/sms/inbound", params, "tok");
    const urls = inboundSmsUrlCandidates(req({ host: "app.empirevu.com" }));
    expect(urls.some((u) => verifyTwilioSignature(u, params, sig, "tok"))).toBe(true);
    // ...but never without the right auth token.
    expect(urls.some((u) => verifyTwilioSignature(u, params, sig, "other-token"))).toBe(false);
  });
});
