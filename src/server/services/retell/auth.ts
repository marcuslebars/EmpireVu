/**
 * PII discipline for Retell payloads.
 *
 * A Retell webhook carries the full call transcript and caller PII. It is written
 * to the database (retell_calls) but MUST NOT hit stdout in normal operation. Raw
 * logging is available only for schema discovery, gated behind RETELL_DEBUG_PAYLOADS
 * and off by default.
 */

import crypto from "node:crypto";

export const RETELL_FUNCTION_SECRET_HEADER = "x-empirevu-retell-secret";

/**
 * The mid-call custom-function endpoint (capture-lead) is invoked by Retell as a
 * tool call, which does not carry the webhook HMAC signature, so a shared-secret
 * header is the gate. Compared timing-safely and failing closed: a missing header,
 * a missing env secret, or any mismatch is a rejection.
 */
export function verifyRetellFunctionSecret(request: Request): boolean {
  const expected = process.env.RETELL_FUNCTION_SECRET?.trim();
  if (!expected) return false;

  const provided = request.headers.get(RETELL_FUNCTION_SECRET_HEADER)?.trim();
  if (!provided) return false;

  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length) return false;
  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

/** True when raw Retell payload logging is switched on for schema discovery. */
export function retellDebugPayloads(): boolean {
  return process.env.RETELL_DEBUG_PAYLOADS?.trim().toLowerCase() === "true";
}

/** Log a raw Retell payload verbatim — ONLY when RETELL_DEBUG_PAYLOADS=true. */
export function logRetellPayload(label: string, payload: unknown): void {
  if (!retellDebugPayloads()) return;
  try {
    console.log(`[retell:${label}] raw payload:`, JSON.stringify(payload));
  } catch {
    console.log(`[retell:${label}] raw payload: <unserializable>`);
  }
}
