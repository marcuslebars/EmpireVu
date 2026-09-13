import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";

import { env } from "@m/lib/env";

/**
 * The Supabase session (access + refresh token) lives in the platform secure store —
 * iOS Keychain, Android Keystore-encrypted storage — never in WebView localStorage or
 * plain preferences. On the web dev server the plugin falls back to localStorage.
 */
const secureStorage: SupportedStorage = {
  getItem: async (key) => {
    const value = await SecureStorage.get(key).catch(() => null);
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  },
  setItem: async (key, value) => {
    await SecureStorage.set(key, value);
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

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
