// Helpers for the one-time Jobber OAuth connect flow. /api/* is outside the session
// middleware, so the connect route is guarded by a shared secret (JOBBER_CONNECT_SECRET)
// and the OAuth `state` is an HMAC bound to the org (CSRF, no server-side storage).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { LEAD_INTAKE_ORG_SLUG } from "@/server/services/lead-intake/routing";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export async function resolveA1OrganizationId(admin: AdminClient): Promise<string | null> {
  const { data } = await admin.from("organizations").select("id").eq("slug", LEAD_INTAKE_ORG_SLUG).maybeSingle();
  return data?.id ?? null;
}

function connectSecret(): string {
  return process.env.JOBBER_CONNECT_SECRET ?? "";
}

function timingEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** True when the caller presented the correct connect secret. */
export function checkConnectKey(provided: string | null | undefined): boolean {
  const secret = connectSecret();
  return Boolean(secret && provided && timingEqual(provided, secret));
}

export function signState(orgId: string): string {
  const nonce = randomBytes(8).toString("hex");
  const payload = `${orgId}.${nonce}`;
  const sig = createHmac("sha256", connectSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/** Verify the OAuth state HMAC; returns the bound orgId or null. */
export function verifyState(state: string | null | undefined): string | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [orgId, nonce, sig] = parts;
  const expected = createHmac("sha256", connectSecret()).update(`${orgId}.${nonce}`).digest("hex");
  return timingEqual(sig, expected) ? orgId : null;
}
