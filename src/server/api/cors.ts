/**
 * CORS for the native mobile app.
 *
 * The Capacitor shell serves its bundled UI from a local origin — `capacitor://localhost`
 * on iOS, `https://localhost` on Android — and calls the API cross-origin with a Bearer
 * token (see `createSupabaseServerClient`). Only those origins, plus any listed in
 * MOBILE_APP_ORIGINS (comma-separated), are allowed.
 *
 * `Access-Control-Allow-Credentials` is deliberately never sent: browsers then refuse to
 * attach the web app's auth cookie to cross-origin requests, so a page on some other
 * localhost cannot ride a signed-in user's session. A cross-origin caller must present
 * its own token.
 */
const MOBILE_APP_ORIGINS = ["capacitor://localhost", "https://localhost", "http://localhost"];

export function allowedCorsOrigins(env: string | undefined = process.env.MOBILE_APP_ORIGINS): string[] {
  const extra = (env ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  return [...MOBILE_APP_ORIGINS, ...extra];
}

export function corsHeadersFor(origin: string | null, allowed = allowedCorsOrigins()): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) {
    return null;
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
