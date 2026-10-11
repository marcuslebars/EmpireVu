/**
 * The carrier account number and PIN, encrypted at rest (docs/ai-staff.md → "Keep your number").
 *
 * AES-256-GCM with a server key from env PORTING_ENCRYPTION_KEY: 32 random bytes, base64.
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * or:                 openssl rand -base64 32
 *
 * Ciphertext format "v1.<iv>.<tag>.<data>" (base64url, 12-byte IV, 16-byte tag). The port row's
 * id is the additional authenticated data, so a ciphertext copied onto another row won't decrypt.
 * No key (or a malformed one) → `portingKey()` is null and the app collects neither value: the
 * form says "we'll call you for your account number and PIN". Values are never logged.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const TAG_BYTES = 16;
let warned = false;

/** The 32-byte key, or null when PORTING_ENCRYPTION_KEY is unset or not 32 bytes of base64. */
export function portingKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.PORTING_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    if (!warned) {
      warned = true;
      console.error("[porting] PORTING_ENCRYPTION_KEY must be 32 bytes, base64 - account numbers and PINs are not collected in the app.");
    }
    return null;
  }
  return key;
}

export function encryptionAvailable(): boolean {
  return portingKey() !== null;
}

export function encryptSecret(plain: string, aad: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

/** The plain value, or null when it can't be decrypted (wrong key / row / tampered). */
export function decryptSecret(cipherText: string | null | undefined, aad: string, key: Buffer): string | null {
  if (!cipherText) return null;
  const parts = cipherText.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [, ivText, tagText, data] = parts;
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    // A truncated tag would weaken the authentication: only full 16-byte tags (and 12-byte IVs).
    if (tag.length !== TAG_BYTES || iv.length !== 12) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** "••••1234" style last four for display (never more). */
export function lastFour(value: string): string {
  const digits = value.replace(/\s+/g, "");
  return digits.slice(-4);
}
