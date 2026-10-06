/**
 * Token encryption at rest (AES-256-GCM) and the signed OAuth `state`.
 * ACCOUNTING_TOKEN_KEY is 32 random bytes, base64 (`openssl rand -base64 32`). Rotating it
 * makes stored tokens unreadable — every connection then asks to reconnect.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key(): Buffer {
  const k = Buffer.from(process.env.ACCOUNTING_TOKEN_KEY?.trim() ?? "", "base64");
  if (k.length !== 32) throw new Error("ACCOUNTING_TOKEN_KEY must be 32 bytes, base64-encoded.");
  return k;
}

/** "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(blob: string): string {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unreadable token.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export interface OAuthState {
  provider: "quickbooks" | "xero";
  organizationId: string;
  companyId: string;
  profileId: string;
  /** Unix ms after which the state is refused. */
  exp: number;
  nonce: string;
}

const STATE_TTL_MS = 15 * 60_000;

function stateKey(): Buffer {
  // A separate key derived from the token key, so the two uses never share a secret.
  return createHmac("sha256", key()).update("accounting-oauth-state").digest();
}

export function signState(s: Omit<OAuthState, "exp" | "nonce">, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: now + STATE_TTL_MS, nonce: randomBytes(8).toString("hex") })).toString("base64url");
  const sig = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string | null | undefined, now = Date.now()): OAuthState | null {
  if (!state) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", stateKey()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (typeof s.exp !== "number" || s.exp < now) return null;
    if (s.provider !== "quickbooks" && s.provider !== "xero") return null;
    return s;
  } catch {
    return null;
  }
}
