export const env = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, ""),
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? "",
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
};

/** All three are compiled in at build time; without them nothing can reach the backend. */
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
export const APP_SCHEME = "com.empirevu.app";
export const AUTH_CALLBACK_URL = `${APP_SCHEME}://auth-callback`;
