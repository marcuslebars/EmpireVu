/**
 * Everdoer rebrand (REBRAND_PLAN.md §3.1): what the middleware does with requests on the OLD
 * platform hosts. Edge-safe and PURE (no Node APIs; imports only the pure host list).
 *
 *   app.empirevu.com, app.crankleads.com  page GET/HEAD → 301 to the same path + query on
 *                                         EVERDOER_APP_BASE_URL, once switched on (below);
 *                                         /api/*, /embed/*, /f/* and auth callbacks answer
 *                                         in place, forever.
 *   api.empirevu.com                      never redirects (mobile builds, intake, Retell).
 *   tenant hosts (quotes.a1marine*.ca)    never touched.
 *
 * The 301 is DORMANT until BOTH EVERDOER_REDIRECT_LEGACY_HOSTS=1 and a valid
 * EVERDOER_APP_BASE_URL are set. The separate switch is deliberate: setting (or renaming to)
 * EVERDOER_APP_BASE_URL alone must never start redirecting people. Unsetting
 * EVERDOER_REDIRECT_LEGACY_HOSTS is the instant rollback.
 */
import { OLD_PLATFORM_HOSTS, isAllowedEverdoerAppHost, isOldPlatformHost } from "./platform-hosts";

/** Old app hosts whose page views move to the new app host. Never api.empirevu.com. */
export const LEGACY_APP_HOSTS = OLD_PLATFORM_HOSTS.filter((h) => h.startsWith("app.")) as readonly string[];

/** The old API alias. Counted, never redirected. */
export const LEGACY_API_HOST = "api.empirevu.com";

function bareHost(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

export function isLegacyAppHost(host: string | null | undefined): boolean {
  return LEGACY_APP_HOSTS.includes(bareHost(host));
}

export function isLegacyApiHost(host: string | null | undefined): boolean {
  return bareHost(host) === LEGACY_API_HOST;
}

/** Paths that answer in place on an old host: APIs and the embeddable lead form. */
const PASSTHROUGH_SEGMENTS = ["api", "embed", "f", ".well-known"];

/** /api, /embed, /f and /.well-known (with or without more path; any case) answer in place.
 *  /.well-known is for app-site-association / ACME, which must never move hosts. */
export function isApiLikePath(pathname: string): boolean {
  const first = pathname.split("/")[1]?.toLowerCase() ?? "";
  return PASSTHROUGH_SEGMENTS.includes(first);
}

/**
 * Page paths that must NEVER be redirected off an old host, because the browser state they need
 * lives in the OLD origin's storage/cookies (Supabase PKCE code verifier) or because a provider
 * holds the exact URL:
 *   /oauth/callback   Google sign-in returns here; the PKCE verifier is in the old origin.
 *   /update-password  password-recovery / set-password links (resetPasswordForEmail and the
 *                     done-for-you welcome email) — PKCE verifier / recovery session.
 */
const NEVER_REDIRECT_PAGES = [/^\/oauth\/callback(\/|$)/, /^\/update-password\/?$/];

/** Query params Supabase appends when it sends someone back to the Site URL after an email
 *  confirmation or magic link (the code must be exchanged on the origin that started it). */
const AUTH_QUERY_PARAMS = ["code", "token_hash"];

export interface LegacyRedirectEnv {
  EVERDOER_REDIRECT_LEGACY_HOSTS?: string;
  EVERDOER_APP_BASE_URL?: string;
}

/** The target origin when the redirect is switched on, else null. */
export function legacyRedirectOrigin(env: LegacyRedirectEnv): string | null {
  const flag = env.EVERDOER_REDIRECT_LEGACY_HOSTS?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "yes") return null;
  // Deliberately NO fallback to CRANKLEADS_APP_BASE_URL / APP_BASE_URL here: those are old hosts.
  const raw = env.EVERDOER_APP_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Only ever redirect to an everdoer host (or a dev host): a copied old value would bounce
    // people between old hosts, and any other host is not ours.
    if (isOldPlatformHost(url.hostname) || !isAllowedEverdoerAppHost(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface LegacyHostRequest {
  host: string | null;
  method: string;
  pathname: string;
  search: string;
  searchParams?: URLSearchParams;
}

/**
 * Where to 301 this request, or null to serve it in place. PURE.
 */
export function legacyHostRedirect(req: LegacyHostRequest, env: LegacyRedirectEnv): string | null {
  const origin = legacyRedirectOrigin(env);
  if (!origin) return null;
  if (!isLegacyAppHost(req.host)) return null;
  if (bareHost(req.host) === bareHost(new URL(origin).host)) return null;
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (isApiLikePath(req.pathname)) return null;
  if (isNextInternalOrAsset(req.pathname)) return null;
  if (NEVER_REDIRECT_PAGES.some((re) => re.test(req.pathname))) return null;
  const params = req.searchParams ?? new URLSearchParams(req.search);
  if (AUTH_QUERY_PARAMS.some((p) => params.has(p))) return null;
  return `${origin}${req.pathname}${req.search}`;
}

/** Next internals and static files (anything with a file extension in the last segment). */
export function isNextInternalOrAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next/") || pathname.startsWith("/__next")) return true;
  const last = pathname.split("/").pop() ?? "";
  return /\.[a-z0-9]{1,12}$/i.test(last);
}

/**
 * A path safe to store as a legacy-usage sample: the first segment verbatim, later segments that
 * look like ids or tokens (any digit, or long) replaced by ":id", so a quote / invoice / setup
 * token in the path never reaches the table. PURE.
 */
export function legacyPathSample(pathname: string): string {
  const parts = pathname.split("/");
  return parts
    .map((seg, i) => (i <= 1 || !(/\d/.test(seg) || seg.length > 24) ? seg : ":id"))
    .join("/")
    .slice(0, 200);
}
