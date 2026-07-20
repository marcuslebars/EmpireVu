import crypto from "node:crypto";

/**
 * Standard Webhooks signature verification (the scheme OpenAI uses for its
 * webhooks, via `webhook-id` / `webhook-timestamp` / `webhook-signature`).
 *
 * Implemented against node:crypto rather than pulling in an SDK — same
 * zero-new-dependency discipline as the other outbound integrations.
 *
 * This gates a PUBLIC endpoint, so it fails closed: anything missing,
 * malformed, stale, or mismatched returns false.
 */
export interface VerifyStandardWebhookInput {
  id: string | null;
  /** The RAW request body, exactly as received — re-serializing breaks the HMAC. */
  payload: string;
  secret: string;
  signatureHeader: string | null;
  timestamp: string | null;
  /** Reject deliveries older/newer than this, to blunt replays. */
  toleranceSeconds?: number;
}

export function verifyStandardWebhook({
  id,
  payload,
  secret,
  signatureHeader,
  timestamp,
  toleranceSeconds = 300,
}: VerifyStandardWebhookInput): boolean {
  if (!secret || !id || !timestamp || !signatureHeader) {
    return false;
  }

  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - sentAt) > toleranceSeconds) {
    return false;
  }

  // Secrets are distributed as `whsec_<base64>`.
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(rawSecret, "base64");
  } catch {
    return false;
  }
  if (keyBytes.length === 0) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", keyBytes)
    .update(`${id}.${timestamp}.${payload}`)
    .digest();

  // The header is a space-separated list of `v<version>,<base64 signature>`.
  for (const entry of signatureHeader.split(" ")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(",");
    if (separator < 0) continue;

    const version = trimmed.slice(0, separator);
    const candidate = trimmed.slice(separator + 1);
    if (version !== "v1" || !candidate) continue;

    let candidateBytes: Buffer;
    try {
      candidateBytes = Buffer.from(candidate, "base64");
    } catch {
      continue;
    }

    if (
      candidateBytes.length === expected.length &&
      crypto.timingSafeEqual(candidateBytes, expected)
    ) {
      return true;
    }
  }

  return false;
}
