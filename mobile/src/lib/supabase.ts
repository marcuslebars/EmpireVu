import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { createClient, isAuthRetryableFetchError, type AuthError, type Session, type SupportedStorage } from "@supabase/supabase-js";

import { env } from "@m/lib/env";

/**
 * The Supabase session (access + refresh token) lives in the platform secure store —
 * iOS Keychain, Android Keystore-encrypted storage — never in WebView localStorage or
 * plain preferences. On the web dev server the plugin falls back to localStorage.
 */
/**
 * A write to the Keychain / Keystore failed — the entry is usually invalidated by a
 * screen-lock or biometric enrolment change. Thrown so the sign-in screens can show it
 * instead of hanging on a promise that never settles.
 */
export class SessionStorageError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("Couldn't save your session on this device. Check your screen lock, then try again.");
    this.name = "SessionStorageError";
    this.reason = reason;
  }
}

const secureStorage: SupportedStorage = {
  getItem: async (key) => {
    const value = await SecureStorage.get(key).catch(() => null);
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  },
  setItem: async (key, value) => {
    try {
      await SecureStorage.set(key, value);
    } catch (error) {
      throw new SessionStorageError(error);
    }
  },
  removeItem: async (key) => {
    await SecureStorage.remove(key).catch(() => false);
  },
};

export const supabase = createClient(env.supabaseUrl || "https://unconfigured.invalid", env.supabaseAnonKey || "unconfigured", {
  auth: {
    storage: secureStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});

/** Set once a session has been seen, so "signed out" and "refresh failed" stay distinguishable. */
let hadSession = false;

/**
 * The last session auth-js told us about. `getSession` reads the Keychain / Keystore on every
 * call, and every API request needs a token, so a cold start used to do hundreds of secure-store
 * reads. auth-js announces every change to the stored session (sign-in, refresh, user update,
 * sign-out), so the in-memory copy stays current; near expiry we fall back to `getSession`,
 * which refreshes.
 */
let current: Session | null = null;

export function noteSignedOut(): void {
  hadSession = false;
  current = null;
}

/** A refresh token the server rejected is dead; anything else (offline, 5xx) is retryable. */
export function refreshTokenRejected(error: { status?: number; message?: string } | null): boolean {
  if (!error) return false;
  if (error.status === 400 || error.status === 401) return true;
  return /invalid refresh token|refresh_token_not_found|already used/i.test(error.message ?? "");
}

/**
 * What cold start found in the secure store:
 * - `session`: a usable session (refreshed if it had expired).
 * - `unreachable`: a session is stored but its expired access token couldn't be refreshed
 *   because the auth server was unreachable. auth-js keeps the stored session in that case and
 *   its auto-refresh ticker retries it, so this is "offline", not "signed out".
 * - `none`: nothing stored, or the server rejected the refresh token (auth-js has already
 *   removed the session and emitted SIGNED_OUT).
 */
export type RestoredSession = { kind: "session"; session: Session } | { kind: "unreachable" } | { kind: "none" };

export function classifyRestore(session: Session | null, error: AuthError | null): RestoredSession {
  if (session) return { kind: "session", session };
  if (error && isAuthRetryableFetchError(error) && !refreshTokenRejected(error)) return { kind: "unreachable" };
  return { kind: "none" };
}

export async function restoreSession(): Promise<RestoredSession> {
  const { data, error } = await supabase.auth.getSession();
  const restored = classifyRestore(data.session, error);
  hadSession = restored.kind !== "none";
  if (restored.kind === "session") current = restored.session;
  return restored;
}

/** Same margin auth-js uses before it treats a token as expired and refreshes it. */
const EXPIRY_MARGIN_MS = 90_000;

supabase.auth.onAuthStateChange((event, session) => {
  current = event === "SIGNED_OUT" ? null : (session ?? current);
});

function freshToken(): string | null {
  if (!current?.expires_at) return null;
  return current.expires_at * 1000 - Date.now() > EXPIRY_MARGIN_MS ? current.access_token : null;
}

/**
 * The Bearer token for API calls. `getSession` refreshes an expired token itself; when that
 * refresh fails it returns no session while keeping the stored one, so a bare `?? null` would
 * send the request unauthenticated and surface as a 401. Retry the refresh once, then either
 * sign out (token genuinely dead) or throw (transient — the caller shows an offline error).
 */
export async function getAccessToken(): Promise<string | null> {
  const cached = freshToken();
  if (cached) return cached;

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    hadSession = true;
    current = data.session;
    return data.session.access_token;
  }
  if (!hadSession) return null;

  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.data.session) return refreshed.data.session.access_token;
  if (refreshTokenRejected(refreshed.error)) {
    hadSession = false;
    await supabase.auth.signOut().catch(() => undefined);
    return null;
  }
  throw new Error("Couldn't refresh your session. Check your connection and try again.");
}
