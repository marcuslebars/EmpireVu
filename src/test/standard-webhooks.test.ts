import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyStandardWebhook } from "@/server/webhooks/standard-webhooks";

const SECRET_BYTES = Buffer.from("super-secret-signing-key-for-tests");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function sign(id: string, timestamp: string, payload: string, key: Buffer = SECRET_BYTES): string {
  const digest = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return `v1,${digest}`;
}

describe("verifyStandardWebhook", () => {
  const id = "evt_685343a1381c819085d44c354e1b330e";
  const payload = JSON.stringify({
    data: { call_id: "call_123" },
    type: "realtime.call.incoming",
  });

  it("accepts a correctly signed payload", () => {
    const timestamp = String(nowSeconds());
    expect(
      verifyStandardWebhook({
        id,
        payload,
        secret: SECRET,
        signatureHeader: sign(id, timestamp, payload),
        timestamp,
      }),
    ).toBe(true);
  });

  it("accepts a secret supplied without the whsec_ prefix", () => {
    const timestamp = String(nowSeconds());
    expect(
      verifyStandardWebhook({
        id,
        payload,
        secret: SECRET_BYTES.toString("base64"),
        signatureHeader: sign(id, timestamp, payload),
        timestamp,
      }),
    ).toBe(true);
  });

  it("accepts when the header carries several space-separated signatures", () => {
    const timestamp = String(nowSeconds());
    const valid = sign(id, timestamp, payload);
    expect(
      verifyStandardWebhook({
        id,
        payload,
        secret: SECRET,
        signatureHeader: `v1,c29tZS1vdGhlci1zaWduYXR1cmU= ${valid}`,
        timestamp,
      }),
    ).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const timestamp = String(nowSeconds());
    const signatureHeader = sign(id, timestamp, payload);
    expect(
      verifyStandardWebhook({
        id,
        payload: payload.replace("call_123", "call_evil"),
        secret: SECRET,
        signatureHeader,
        timestamp,
      }),
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const timestamp = String(nowSeconds());
    expect(
      verifyStandardWebhook({
        id,
        payload,
        secret: SECRET,
        signatureHeader: sign(id, timestamp, payload, Buffer.from("not-the-right-key")),
        timestamp,
      }),
    ).toBe(false);
  });

  it("rejects a replayed delivery outside the tolerance window", () => {
    const timestamp = String(nowSeconds() - 3_600);
    expect(
      verifyStandardWebhook({
        id,
        payload,
        secret: SECRET,
        signatureHeader: sign(id, timestamp, payload),
        timestamp,
      }),
    ).toBe(false);
  });

  it("rejects a mismatched id even when the body signature would otherwise match", () => {
    const timestamp = String(nowSeconds());
    expect(
      verifyStandardWebhook({
        id: "evt_someone_elses",
        payload,
        secret: SECRET,
        signatureHeader: sign(id, timestamp, payload),
        timestamp,
      }),
    ).toBe(false);
  });

  it("rejects unknown signature versions", () => {
    const timestamp = String(nowSeconds());
    const digest = sign(id, timestamp, payload).slice("v1,".length);
    expect(
      verifyStandardWebhook({
        id,
        payload,
        secret: SECRET,
        signatureHeader: `v2,${digest}`,
        timestamp,
      }),
    ).toBe(false);
  });

  it("fails closed when headers or the secret are missing", () => {
    const timestamp = String(nowSeconds());
    const signatureHeader = sign(id, timestamp, payload);
    const base = { id, payload, secret: SECRET, signatureHeader, timestamp };

    expect(verifyStandardWebhook({ ...base, id: null })).toBe(false);
    expect(verifyStandardWebhook({ ...base, signatureHeader: null })).toBe(false);
    expect(verifyStandardWebhook({ ...base, timestamp: null })).toBe(false);
    expect(verifyStandardWebhook({ ...base, secret: "" })).toBe(false);
    expect(verifyStandardWebhook({ ...base, timestamp: "not-a-number" })).toBe(false);
    expect(verifyStandardWebhook({ ...base, signatureHeader: "garbage" })).toBe(false);
  });
});
