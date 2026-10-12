/**
 * Resend webhook signatures (Svix scheme — https://resend.com/docs/webhooks/verify-webhooks-requests
 * and https://docs.svix.com/receiving/verifying-payloads/how-manual):
 *
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   key            = base64-decode(secret without its "whsec_" prefix)
 *   signature      = base64(HMAC-SHA256(key, signed content))
 *   svix-signature = space-separated "v1,<sig>" entries; one must match (constant-time)
 *   svix-timestamp = Unix seconds; rejected outside ±5 minutes (replay guard)
 *
 * The RAW body is verified — never a re-stringified parse. PURE (node:crypto only).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_S = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing_headers" | "bad_secret" | "stale" | "mismatch" };

function keyFrom(secret: string): Buffer | null {
  const raw = secret.trim().replace(/^whsec_/, "");
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** The expected `v1` signature for a payload (tests use it to sign fixtures). */
export function signPayload(secret: string, id: string, timestamp: string, body: string): string {
  const key = keyFrom(secret);
  if (!key) throw new Error("bad secret");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function verifySvixSignature(secret: string, headers: SvixHeaders, rawBody: string, nowMs: number = Date.now()): VerifyResult {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing_headers" };
  const key = keyFrom(secret);
  if (!key) return { ok: false, reason: "bad_secret" };
  if (!/^\d{1,12}$/.test(headers.timestamp.trim())) return { ok: false, reason: "stale" };
  const ts = Number(headers.timestamp.trim());
  if (Math.abs(nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: "stale" };
  const expected = Buffer.from(createHmac("sha256", key).update(`${headers.id}.${headers.timestamp.trim()}.${rawBody}`).digest("base64"));
  for (const part of headers.signature.trim().split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) !== "v1") continue;
    const given = Buffer.from(part.slice(comma + 1));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
