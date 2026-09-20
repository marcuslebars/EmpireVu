import { Browser } from "@capacitor/browser";

import { AUTH_CALLBACK_URL } from "@m/lib/env";
import { isNative } from "@m/lib/native";
import { supabase } from "@m/lib/supabase";

/**
 * Auth actions. Every redirect comes back through the app's URL scheme
 * (com.empirevu.app://auth-callback) — it must be listed under Supabase →
 * Authentication → URL Configuration → Redirect URLs.
 */
type Result = { error: string | null };

const ok: Result = { error: null };
const fail = (error: { message: string } | null): Result => (error ? { error: error.message } : ok);

/**
 * Deliberate credential sign-ins (password, provider, phone code, email link) are marked so
 * the session state machine can tell them apart from the `SIGNED_IN` that auth-js replays for
 * an already-stored session every time the app returns to the foreground. Without that, coming
 * back from the background would clear the biometric lock.
 */
let credentialAuthAt = 0;

function markCredentialAuth(): void {
  credentialAuthAt = Date.now();
}

export function consumeCredentialAuth(): boolean {
  const recent = Date.now() - credentialAuthAt < 120_000;
  credentialAuthAt = 0;
  return recent;
}

/**
 * Auth calls write the session to the Keychain / Keystore, which can fail (see
 * `SessionStorageError`). Without this every caller would hang on a rejected promise with its
 * button stuck in the loading state.
 */
async function attempt(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    credentialAuthAt = 0;
    return { error: error instanceof Error && error.message ? error.message : "Something went wrong. Try again." };
  }
}

export async function signInWithPassword(email: string, password: string): Promise<Result> {
  markCredentialAuth();
  return attempt(async () => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    return fail(error);
  });
}

export async function signUp(email: string, password: string): Promise<Result & { needsConfirmation: boolean }> {
  markCredentialAuth();
  let hasSession = false;
  const result = await attempt(async () => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: AUTH_CALLBACK_URL },
    });
    hasSession = Boolean(data.session);
    return fail(error);
  });
  return { ...result, needsConfirmation: !result.error && !hasSession };
}

export async function sendPasswordReset(email: string): Promise<Result> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${AUTH_CALLBACK_URL}?flow=recovery`,
  });
  return fail(error);
}

export async function updatePassword(password: string): Promise<Result> {
  return attempt(async () => {
    const { error } = await supabase.auth.updateUser({ password });
    return fail(error);
  });
}

/** E.164; a bare 10-digit North American number gets +1. */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function sendPhoneCode(phone: string): Promise<Result> {
  const { error } = await supabase.auth.signInWithOtp({ phone: normalizePhone(phone) });
  return fail(error);
}

export async function verifyPhoneCode(phone: string, token: string): Promise<Result> {
  markCredentialAuth();
  return attempt(async () => {
    const { error } = await supabase.auth.verifyOtp({ phone: normalizePhone(phone), token, type: "sms" });
    return fail(error);
  });
}

export async function signInWithProvider(provider: "google" | "apple"): Promise<Result> {
  markCredentialAuth();
  return attempt(async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error || !data.url) return fail(error ?? { message: "Could not start sign-in." });
    if (isNative) {
      await Browser.open({ url: data.url, presentationStyle: "popover" });
    } else {
      window.location.href = data.url;
    }
    return ok;
  });
}

/**
 * Handle com.empirevu.app://auth-callback?code=…[&flow=recovery]. Returns the flow the
 * link belonged to, or null when the URL was not an auth callback.
 */
export async function handleAuthCallback(url: string): Promise<{ flow: "signin" | "recovery"; error: string | null } | null> {
  if (!url.startsWith(AUTH_CALLBACK_URL)) return null;
  if (isNative) void Browser.close().catch(() => undefined);

  const parsed = new URL(url.replace(/^[^:]+:\/\//, "https://callback/"));
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const code = parsed.searchParams.get("code");
  const flow = parsed.searchParams.get("flow") === "recovery" || hash.get("type") === "recovery" ? "recovery" : "signin";
  const linkError = parsed.searchParams.get("error_description") ?? hash.get("error_description");

  if (linkError) return { flow, error: linkError };
  if (!code) return { flow, error: "That link is invalid or has expired." };

  markCredentialAuth();
  const result = await attempt(async () => {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return fail(error);
  });
  return { flow, error: result.error };
}
