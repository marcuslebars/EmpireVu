import crypto from "node:crypto";

/**
 * Verify Retell's webhook signature.
 *
 * The `X-Retell-Signature` header carries `v={unix_ms_timestamp},d={hex_digest}`.
 * The digest is HMAC-SHA256(apiKey, rawBody + timestamp) — the RAW request body
 * string concatenated with the timestamp taken from the `v=` field (confirmed
 * against Retell's docs and reference Go impl: `mac.Write(rawBody + timestamp)`).
 * Retell's signing secret IS the API key.
 *
 * Fails closed: a missing or malformed header, a missing key, a digest mismatch, or
 * a timestamp outside the replay window all return false. Comparison is timing-safe.
 *
 * `rawBody` MUST be the exact bytes received — never a re-serialized JSON string, or
 * whitespace/key-order differences will break the digest.
 */
export function verifyRetellSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  apiKey: string | null | undefined,
  toleranceMs = 5 * 60 * 1000,
  nowMs: number = Date.now(),
): boolean {
  if (!apiKey || !signatureHeader) return false;

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const { timestamp, digest } = parsed;

  // Replay window: reject stale (or absurdly future) timestamps.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > toleranceMs) return false;

  const expected = crypto
    .createHmac("sha256", apiKey)
    .update(rawBody + timestamp, "utf8")
    .digest("hex");

  return timingSafeEqualHex(expected, digest);
}

/** Parse "v=<unix_ms>,d=<hex>" — tolerant of whitespace and field order. */
function parseSignatureHeader(header: string): { timestamp: string; digest: string } | null {
  let timestamp: string | null = null;
  let digest: string | null = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (!key || !val) continue;
    if (key === "v") timestamp = val;
    else if (key === "d") digest = val;
  }
  if (!timestamp || !digest) return null;
  return { timestamp, digest };
}

/** Constant-time compare of two hex digests; unequal lengths never match. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
