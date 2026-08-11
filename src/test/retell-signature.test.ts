import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyRetellSignature } from "@/server/services/retell/signature";

const API_KEY = "key_test_abc123";
const BODY = JSON.stringify({ event: "call_analyzed", call: { call_id: "call_1" } });
const NOW = 1_754_000_000_000; // fixed clock so the replay window is deterministic
const WINDOW = 5 * 60 * 1000;

/** Build a header exactly as Retell does: HMAC-SHA256(apiKey, rawBody + timestamp). */
function sign(body: string, key: string, tsMs: number): string {
  const digest = createHmac("sha256", key)
    .update(body + String(tsMs), "utf8")
    .digest("hex");
  return `v=${tsMs},d=${digest}`;
}

describe("verifyRetellSignature (X-Retell-Signature: v={ms},d={hex})", () => {
  it("accepts a correctly signed request", () => {
    expect(verifyRetellSignature(BODY, sign(BODY, API_KEY, NOW), API_KEY, WINDOW, NOW)).toBe(true);
  });

  it("rejects a tampered body (raw bytes must match exactly)", () => {
    expect(verifyRetellSignature(`${BODY} `, sign(BODY, API_KEY, NOW), API_KEY, WINDOW, NOW)).toBe(false);
  });

  it("rejects a wrong or missing key", () => {
    const sig = sign(BODY, API_KEY, NOW);
    expect(verifyRetellSignature(BODY, sig, "wrong-key", WINDOW, NOW)).toBe(false);
    expect(verifyRetellSignature(BODY, sig, "", WINDOW, NOW)).toBe(false);
    expect(verifyRetellSignature(BODY, sig, null, WINDOW, NOW)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyRetellSignature(BODY, null, API_KEY, WINDOW, NOW)).toBe(false);
    expect(verifyRetellSignature(BODY, "garbage", API_KEY, WINDOW, NOW)).toBe(false);
    expect(verifyRetellSignature(BODY, `v=${NOW}`, API_KEY, WINDOW, NOW)).toBe(false);
    expect(verifyRetellSignature(BODY, `v=${NOW},d=zzzz`, API_KEY, WINDOW, NOW)).toBe(false);
  });

  it("rejects a replayed / stale timestamp outside the window", () => {
    const stale = NOW - 6 * 60 * 1000; // 6 min ago; window is 5 min
    expect(verifyRetellSignature(BODY, sign(BODY, API_KEY, stale), API_KEY, WINDOW, NOW)).toBe(false);
  });

  it("accepts a timestamp within the window", () => {
    const recent = NOW - 2 * 60 * 1000;
    expect(verifyRetellSignature(BODY, sign(BODY, API_KEY, recent), API_KEY, WINDOW, NOW)).toBe(true);
  });

  it("tolerates field order and surrounding whitespace in the header", () => {
    const digest = createHmac("sha256", API_KEY)
      .update(BODY + String(NOW), "utf8")
      .digest("hex");
    expect(verifyRetellSignature(BODY, ` d=${digest} , v=${NOW} `, API_KEY, WINDOW, NOW)).toBe(true);
  });
});
