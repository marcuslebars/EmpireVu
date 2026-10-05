/**
 * SANCTIONED EXCEPTION (service role): accounting OAuth tokens.
 *
 * `accounting_tokens` has RLS on and no policies. Only this module reads or writes it,
 * always by the company id of a connection the caller already resolved (an owner/admin
 * route under their own session, or the worker for a claimed job). Tokens are encrypted
 * (./crypto). Both providers ROTATE refresh tokens, so a refresh persists the new pair
 * before using it, and refreshes are serialized by a DB lock (refresh_lock_at) so two
 * workers can't race and orphan the connection.
 */
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { decryptSecret, encryptSecret } from "./crypto";
import { providerFor } from "./providers";
import { ProviderError, type ProviderSession, type TokenSet } from "./types";

type Admin = ReturnType<typeof createSupabaseAdminClient>;

const LOCK_TTL_MS = 30_000;
const WAIT_MS = 400;
const WAIT_TRIES = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function saveTokens(admin: Admin, companyId: string, t: TokenSet): Promise<void> {
  const { error } = await admin.from("accounting_tokens").upsert(
    {
      company_id: companyId,
      access_token_enc: encryptSecret(t.accessToken),
      refresh_token_enc: encryptSecret(t.refreshToken),
      access_expires_at: t.accessExpiresAt.toISOString(),
      refresh_expires_at: t.refreshExpiresAt?.toISOString() ?? null,
      refresh_lock_at: null,
    },
    { onConflict: "company_id" },
  );
  if (error) throw error;
}

export async function readTokens(admin: Admin, companyId: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  const { data, error } = await admin.from("accounting_tokens").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  try {
    return { accessToken: decryptSecret(data.access_token_enc), refreshToken: decryptSecret(data.refresh_token_enc) };
  } catch {
    return null;
  }
}

async function markNeedsReauth(admin: Admin, companyId: string, message: string): Promise<void> {
  await admin.from("accounting_connections").update({ status: "needs_reauth", last_error: message }).eq("company_id", companyId);
}

/**
 * An authorised session for the company's connected file, refreshing (with rotation)
 * when the access token is about to expire.
 */
export async function sessionFor(
  admin: Admin,
  conn: { company_id: string; provider: string; remote_tenant_id: string; environment: string },
  f: typeof fetch = fetch,
): Promise<ProviderSession> {
  const provider = providerFor(conn.provider);
  const make = (accessToken: string): ProviderSession => ({
    tenantId: conn.remote_tenant_id,
    accessToken,
    environment: conn.environment === "sandbox" ? "sandbox" : "production",
    fetch: f,
  });
  const load = async () => {
    const { data, error } = await admin.from("accounting_tokens").select("*").eq("company_id", conn.company_id).maybeSingle();
    if (error) throw error;
    return data;
  };
  const fresh = (row: { access_expires_at: string }) => Date.parse(row.access_expires_at) - Date.now() > 5_000;

  let row = await load();
  if (!row) {
    await markNeedsReauth(admin, conn.company_id, "The sign-in is missing — reconnect.");
    throw new ProviderError("The accounting file isn't signed in — reconnect it in Settings → Accounting.", { reauth: true });
  }
  const decrypt = (blob: string) => {
    try {
      return decryptSecret(blob);
    } catch {
      return null;
    }
  };
  if (fresh(row)) {
    const token = decrypt(row.access_token_enc);
    if (token) return make(token);
  }

  // Take the refresh lock (only if free or stale); losers wait for the winner's token.
  const { data: won, error: lockErr } = await admin.rpc("claim_accounting_token_refresh", {
    p_company_id: conn.company_id,
    p_stale_after_seconds: Math.round(LOCK_TTL_MS / 1000),
  });
  if (lockErr) throw lockErr;
  if (won !== true) {
    for (let i = 0; i < WAIT_TRIES; i++) {
      await sleep(WAIT_MS);
      row = await load();
      if (row && fresh(row)) {
        const token = decrypt(row.access_token_enc);
        if (token) return make(token);
      }
    }
    throw new ProviderError("Timed out waiting for another sign-in refresh.", { retryable: true });
  }

  const lockedRow = await load();
  const refreshToken = lockedRow ? decrypt(lockedRow.refresh_token_enc) : null;
  if (!refreshToken) {
    await markNeedsReauth(admin, conn.company_id, "The stored sign-in can't be read (the encryption key changed?) — reconnect.");
    throw new ProviderError("The accounting sign-in can't be read — reconnect it in Settings → Accounting.", { reauth: true });
  }
  let next: TokenSet;
  try {
    next = await provider.refresh(refreshToken, f);
  } catch (err) {
    await admin.from("accounting_tokens").update({ refresh_lock_at: null }).eq("company_id", conn.company_id);
    if (err instanceof ProviderError && err.reauth) await markNeedsReauth(admin, conn.company_id, err.message);
    throw err;
  }
  try {
    await saveTokens(admin, conn.company_id, next);
  } catch (err) {
    // We hold a rotated refresh token we couldn't store; the old one is now dead.
    await markNeedsReauth(admin, conn.company_id, "Couldn't save the refreshed sign-in — reconnect.");
    throw new Error(`CRITICAL: failed to persist rotated accounting refresh token: ${err instanceof Error ? err.message : err}`);
  }
  return make(next.accessToken);
}
