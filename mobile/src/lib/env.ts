/** api.everdoer.com is the API alias of the hub (same service as app.everdoer.com). */
export const DEFAULT_API_BASE_URL = "https://api.everdoer.com";

export const env = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, ""),
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? "",
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
};

/**
 * All three are compiled in at build time; without them nothing can reach the backend. The API
 * origin falls back to DEFAULT_API_BASE_URL, so in practice only the Supabase pair can be missing.
 */
export const missingEnv = (
  [
    ["VITE_API_BASE_URL", env.apiBaseUrl],
    ["VITE_SUPABASE_URL", env.supabaseUrl],
    ["VITE_SUPABASE_ANON_KEY", env.supabaseAnonKey],
  ] as const
)
  .filter(([, value]) => !value)
  .map(([name]) => name);

/** Deep-link scheme registered in the iOS Info.plist and Android manifest. */
export const APP_SCHEME = "com.everdoer.app";
export const AUTH_CALLBACK_URL = `${APP_SCHEME}://auth-callback`;
