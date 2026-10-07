// Jobber OAuth 2.0 with refresh-token ROTATION. Rotation is ON: every refresh
// returns a NEW refresh token that invalidates the previous one, so the new token
// is persisted BEFORE the new access token is used, and refreshes are serialized by
// a DB-backed lock (refresh_lock_at) so two workers can't race and orphan the
// connection. A lost rotated token needs manual re-authorization → treated as critical.
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import {
  assertJobberConfigured,
  getJobberConfig,
  type JobberConfig,
  type JobberConnectionRow,
} from "./config";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

const EXPIRY_BUFFER_SECONDS = 60; // refresh a minute before actual expiry
const REFRESH_LOCK_TTL_MS = 30_000; // a stale refresh lock is reclaimable after this
const REFRESH_WAIT_MS = 500;
const REFRESH_WAIT_TRIES = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

export function buildAuthorizeUrl(state: string, cfg: JobberConfig = getJobberConfig()): string {
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (cfg.scopes) url.searchParams.set("scope", cfg.scopes);
  return url.toString();
}

async function requestToken(cfg: JobberConfig, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jobber token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

function expiryIso(expiresIn: number): string {
  return new Date(Date.now() + Math.max(expiresIn - EXPIRY_BUFFER_SECONDS, 0) * 1000).toISOString();
}

function tokenFresh(conn: JobberConnectionRow): boolean {
  return Boolean(
    conn.access_token &&
      conn.token_expires_at &&
      new Date(conn.token_expires_at).getTime() - Date.now() > 5_000,
  );
}

async function loadConnection(admin: AdminClient, organizationId: string): Promise<JobberConnectionRow | null> {
  const { data, error } = await admin.from("jobber_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** One-time connect: exchange the authorization code for tokens and store the connection. */
export async function exchangeCodeAndStore(
  admin: AdminClient,
  organizationId: string,
  code: string,
  cfg: JobberConfig = getJobberConfig(),
): Promise<void> {
  assertJobberConfigured(cfg);
  const token = await requestToken(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });
  const { error } = await admin.from("jobber_connections").upsert(
    {
      organization_id: organizationId,
      access_token: token.access_token,
      refresh_token: token.refresh_token, // rotating token — persisted immediately
      token_expires_at: expiryIso(token.expires_in),
      scope: token.scope ?? cfg.scopes,
      refresh_lock_at: null,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" },
  );
  if (error) throw error;
}

/**
 * Return a valid access token, refreshing with rotation if needed. The new refresh
 * token is persisted BEFORE the access token is returned; refreshes are serialized by
 * the refresh_lock_at DB mutex, taken by claim_jobber_token_refresh (Postgres
 * serializes the conditional UPDATE, so only one caller wins the lock). A persistence
 * failure after a refresh is CRITICAL — the old refresh token is now invalid and the
 * connection needs manual re-authorization.
 */
export async function ensureAccessToken(
  admin: AdminClient,
  organizationId: string,
  cfg: JobberConfig = getJobberConfig(),
): Promise<string> {
  assertJobberConfigured(cfg);
  let conn = await loadConnection(admin, organizationId);
  if (!conn || !conn.refresh_token) {
    throw new Error("Jobber is not connected for this organization — run the OAuth connect flow.");
  }
  if (tokenFresh(conn)) return conn.access_token as string;

  // Acquire the refresh lock in SQL (claim_jobber_token_refresh): it sets
  // refresh_lock_at only if null or stale and reports whether THIS caller won.
  // (A PostgREST PATCH with an or= filter can't be used for this — PostgREST re-applies
  // the filter to the returned row, so a successful lock looked like a lost one.)
  const { data: won, error: lockErr } = await admin.rpc("claim_jobber_token_refresh", {
    p_organization_id: organizationId,
    p_stale_after_seconds: Math.round(REFRESH_LOCK_TTL_MS / 1000),
  });
  if (lockErr) throw lockErr;

  if (won !== true) {
    // Another refresh is in progress — wait for it to publish a fresh token.
    for (let i = 0; i < REFRESH_WAIT_TRIES; i++) {
      await sleep(REFRESH_WAIT_MS);
      conn = await loadConnection(admin, organizationId);
      if (conn && tokenFresh(conn)) return conn.access_token as string;
    }
    throw new Error("Timed out waiting for a concurrent Jobber token refresh.");
  }

  const releaseLock = async () => {
    await admin.from("jobber_connections").update({ refresh_lock_at: null }).eq("organization_id", organizationId);
  };

  // Re-read under the lock: another worker may have just finished a refresh (rotating
  // the refresh token) between our first read and winning the lock.
  let current: JobberConnectionRow | null;
  try {
    current = await loadConnection(admin, organizationId);
  } catch (err) {
    await releaseLock();
    throw err;
  }
  if (!current || !current.refresh_token) {
    await releaseLock();
    throw new Error("Jobber is not connected for this organization — run the OAuth connect flow.");
  }
  if (tokenFresh(current)) {
    await releaseLock();
    return current.access_token as string;
  }

  let token: TokenResponse;
  try {
    token = await requestToken(cfg, {
      grant_type: "refresh_token",
      refresh_token: current.refresh_token as string,
    });
  } catch (err) {
    // Refresh failed — release the lock so a later attempt can retry.
    await releaseLock();
    throw err;
  }

  // Persist the NEW refresh token (+ access token) BEFORE returning/using them.
  const { error: saveErr } = await admin.from("jobber_connections")
    .update({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_expires_at: expiryIso(token.expires_in),
      scope: token.scope ?? current.scope,
      refresh_lock_at: null,
    })
    .eq("organization_id", organizationId);
  if (saveErr) {
    // We hold a new rotated refresh token we couldn't persist; the old one is now
    // invalid. Do NOT clear the lock automatically — this needs human attention.
    throw new Error(`CRITICAL: failed to persist rotated Jobber refresh token: ${saveErr.message}`);
  }
  return token.access_token;
}
