import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyJobberWebhook } from "@/server/services/jobber/hmac";

describe("verifyJobberWebhook (base64 HMAC-SHA256)", () => {
  const secret = "client-secret-xyz";
  const body = JSON.stringify({ data: { webHookEvent: { topic: "QUOTE_APPROVAL", itemId: "Q1" } } });
  const sig = createHmac("sha256", secret).update(body, "utf8").digest("base64");

  it("accepts a correct signature", () => {
    expect(verifyJobberWebhook(body, sig, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyJobberWebhook(`${body} `, sig, secret)).toBe(false);
  });

  it("rejects wrong secret / missing header / missing secret", () => {
    expect(verifyJobberWebhook(body, sig, "nope")).toBe(false);
    expect(verifyJobberWebhook(body, null, secret)).toBe(false);
    expect(verifyJobberWebhook(body, sig, "")).toBe(false);
  });
});
