import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Jobber signs each webhook with `X-Jobber-Hmac-SHA256`: the base64 HMAC-SHA256 of
 * the raw request body, keyed by the app's OAuth client secret. Constant-time
 * comparison; returns false on any mismatch or missing header/secret.
 */
export function verifyJobberWebhook(
  rawBody: string,
  signatureHeader: string | null | undefined,
  clientSecret: string,
): boolean {
  if (!signatureHeader || !clientSecret) return false;
  const expected = createHmac("sha256", clientSecret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
