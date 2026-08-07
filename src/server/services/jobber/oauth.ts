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
// The jobber_* tables aren't in the generated database.types.ts yet (see config.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = (admin: AdminClient, name: string): any => (admin as any).from(name);

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
  const { data, error } = await tbl(admin, "jobber_connections")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data as JobberConnectionRow) ?? null;
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
  const { error } = await tbl(admin, "jobber_connections").upsert(
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
 * the refresh_lock_at DB mutex (Postgres serializes the conditional UPDATE, so only
 * one caller wins the lock). A persistence failure after a refresh is CRITICAL — the
 * old refresh token is now invalid and the connection needs manual re-authorization.
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

  // Acquire the refresh lock: set refresh_lock_at only if null or stale. Concurrent
  // callers block on the row lock and re-evaluate the WHERE, so exactly one wins.
  const staleBefore = new Date(Date.now() - REFRESH_LOCK_TTL_MS).toISOString();
  const nowIso = new Date().toISOString();
  const { data: locked, error: lockErr } = await tbl(admin, "jobber_connections")
    .update({ refresh_lock_at: nowIso })
    .eq("organization_id", organizationId)
    .or(`refresh_lock_at.is.null,refresh_lock_at.lt.${staleBefore}`)
    .select("*");
  if (lockErr) throw lockErr;
  const gotLock = Array.isArray(locked) && locked.length > 0;

  if (!gotLock) {
    // Another refresh is in progress — wait for it to publish a fresh token.
    for (let i = 0; i < REFRESH_WAIT_TRIES; i++) {
      await sleep(REFRESH_WAIT_MS);
      conn = await loadConnection(admin, organizationId);
      if (conn && tokenFresh(conn)) return conn.access_token as string;
    }
    throw new Error("Timed out waiting for a concurrent Jobber token refresh.");
  }

  const current = (locked as JobberConnectionRow[])[0];
  let token: TokenResponse;
  try {
    token = await requestToken(cfg, {
      grant_type: "refresh_token",
      refresh_token: current.refresh_token as string,
    });
  } catch (err) {
    // Refresh failed — release the lock so a later attempt can retry.
    await tbl(admin, "jobber_connections").update({ refresh_lock_at: null }).eq("organization_id", organizationId);
    throw err;
  }

  // Persist the NEW refresh token (+ access token) BEFORE returning/using them.
  const { error: saveErr } = await tbl(admin, "jobber_connections")
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
