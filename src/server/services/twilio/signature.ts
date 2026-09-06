import crypto from "node:crypto";

/**
 * Verify Twilio's `X-Twilio-Signature` on an inbound webhook.
 *
 * Twilio signs the request like this (form-encoded POST — what SMS webhooks send):
 *   1. Start with the full request URL exactly as configured in Twilio (scheme, host,
 *      path, and any query string).
 *   2. Sort the POST params by key (ascending), and append each key immediately followed
 *      by its value — no separators.
 *   3. HMAC-SHA1 that string with the account's AUTH TOKEN as the key.
 *   4. Base64-encode the digest.
 * The result must equal the header. See Twilio "Validating requests" docs.
 *
 * Fails closed: a missing token/header/url, a malformed base64 header, or any mismatch
 * returns false. Comparison is constant-time.
 *
 * `url` MUST be the exact URL Twilio signed (the one configured on the number). Behind a
 * proxy the inbound request URL can differ (scheme/host), so the caller reconstructs it
 * from configuration rather than trusting request.url blindly.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null | undefined,
  authToken: string | null | undefined,
): boolean {
  if (!authToken || !signatureHeader || !url) return false;

  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");

  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");

  return timingSafeEqualBase64(expected, signatureHeader);
}

/** Constant-time compare of two base64 strings; malformed input or unequal length → false. */
function timingSafeEqualBase64(a: string, b: string): boolean {
  let ab: Buffer;
  let bb: Buffer;
  try {
    ab = Buffer.from(a, "base64");
    bb = Buffer.from(b, "base64");
  } catch {
    return false;
  }
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
