import crypto from "node:crypto";

import { headerWithFallback, sampleFromUrl } from "@/server/services/rebrand/legacy-usage";

/** The webhook-tool secret header (decision D6). Read new first, then the old name. */
export const TELNYX_SECRET_HEADER = "x-everdoer-telnyx-secret";
// Rebrand shim (remove in PR 8 once legacy_usage shows no header/x-empirevu-telnyx-secret for 30 days)
export const LEGACY_TELNYX_SECRET_HEADER = "x-empirevu-telnyx-secret";

/**
 * Telnyx does not HMAC-sign these webhook-tool requests, so a shared secret
 * header is the only gate on four public endpoints. Compared timing-safely and
 * failing closed: a missing header, a missing env secret, or any mismatch is a
 * rejection.
 */
export function verifyTelnyxSecret(request: Request): boolean {
  const expected = process.env.TELNYX_WEBHOOK_SECRET?.trim();
  if (!expected) {
    return false;
  }

  const provided = headerWithFallback(request.headers, TELNYX_SECRET_HEADER, LEGACY_TELNYX_SECRET_HEADER, sampleFromUrl(request.url))?.trim();
  if (!provided) {
    return false;
  }

  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

/** True when payload logging is switched on for schema discovery. */
export function telnyxDebugPayloads(): boolean {
  return process.env.TELNYX_DEBUG_PAYLOADS?.trim().toLowerCase() === "true";
}

/**
 * Log a raw payload verbatim while the upstream schemas are unconfirmed.
 * Gated so it is off by default — these payloads carry caller PII.
 */
export function logTelnyxPayload(label: string, payload: unknown): void {
  if (!telnyxDebugPayloads()) {
    return;
  }
  try {
    console.log(`[telnyx:${label}] raw payload:`, JSON.stringify(payload));
  } catch {
    console.log(`[telnyx:${label}] raw payload: <unserializable>`);
  }
}
