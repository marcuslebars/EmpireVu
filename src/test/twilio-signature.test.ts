import { describe, expect, it } from "vitest";

import { verifyTwilioSignature } from "@/server/services/twilio/signature";

// Twilio's request-validation algorithm: base64( HMAC-SHA1( authToken, url + concat of
// params sorted by key as key+value ) ). The digest below is that algorithm applied to
// these canonical inputs — a byte-level regression pin (catches a switch to sha256, hex,
// dropped sort, etc.). The negative cases prove the MAC is actually keyed + param-sensitive.
const URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const TOKEN = "12345";
const PARAMS = {
  Digits: "1234",
  To: "+18005551212",
  From: "+14158675310",
  Caller: "+14158675310",
  CallSid: "CA1234567890ABCDE",
};
const VALID_SIGNATURE = "GvWf1cFY/Q7PnoempGyD5oXAezc=";

describe("verifyTwilioSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyTwilioSignature(URL, PARAMS, VALID_SIGNATURE, TOKEN)).toBe(true);
  });

  it("rejects when a param is tampered", () => {
    expect(verifyTwilioSignature(URL, { ...PARAMS, Digits: "9999" }, VALID_SIGNATURE, TOKEN)).toBe(false);
  });

  it("rejects when the URL differs", () => {
    expect(verifyTwilioSignature(URL + "&x=1", PARAMS, VALID_SIGNATURE, TOKEN)).toBe(false);
  });

  it("rejects with the wrong auth token", () => {
    expect(verifyTwilioSignature(URL, PARAMS, VALID_SIGNATURE, "wrong-token")).toBe(false);
  });

  it("fails closed on a missing signature or token", () => {
    expect(verifyTwilioSignature(URL, PARAMS, null, TOKEN)).toBe(false);
    expect(verifyTwilioSignature(URL, PARAMS, VALID_SIGNATURE, null)).toBe(false);
    expect(verifyTwilioSignature(URL, PARAMS, "", TOKEN)).toBe(false);
  });

  it("is insensitive to param object insertion order (sorts by key)", () => {
    const reordered = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      From: "+14158675310",
      To: "+18005551212",
      Digits: "1234",
    };
    expect(verifyTwilioSignature(URL, reordered, VALID_SIGNATURE, TOKEN)).toBe(true);
  });

  it("rejects a garbage signature without throwing", () => {
    expect(verifyTwilioSignature(URL, PARAMS, "!!!not-base64!!!", TOKEN)).toBe(false);
  });
});
