// HS256 JWTs signed with the shared e2e secret (PostgREST verifies them; the stub auth
// server in gateway.mjs mints user sessions with the same helper).
// CLI: node scripts/e2e-dfy/jwt.mjs anon|service_role  → prints a long-lived API key.
import { createHmac } from "node:crypto";

export const JWT_SECRET = process.env.E2E_JWT_SECRET || "e2e-dfy-local-secret-0123456789-abcdefghij";

const b64url = (input) => Buffer.from(input).toString("base64url");

export function signJwt(claims, secret = JWT_SECRET) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token, secret = JWT_SECRET) {
  const [header, payload, sig] = String(token ?? "").split(".");
  if (!header || !payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  if (expected !== sig) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** API keys (anon / service_role) — valid for ten years, like Supabase's. */
export function apiKey(role) {
  const iat = Math.floor(Date.now() / 1000) - 7 * 86400; // see gateway.mjs session()
  return signJwt({ iss: "supabase-e2e", role, iat, exp: iat + 10 * 365 * 86400 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(apiKey(process.argv[2] || "anon"));
}
