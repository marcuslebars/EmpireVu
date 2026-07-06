import { createHmac, timingSafeEqual } from "node:crypto";

/** Signature header format: "sha256=<hex hmac of the raw body, keyed by the secret>". */
export function signIntakeBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** Constant-time verification. Returns false on any mismatch or missing header. */
export function verifyIntakeSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = signIntakeBody(rawBody, secret);
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
