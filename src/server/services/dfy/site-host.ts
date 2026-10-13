/**
 * Host-based serving for generated sites (docs/done-for-you.md → "Generated sites").
 *
 * When PAGES_BASE_URL is set (e.g. https://pages.crankleads.com) and a request arrives on THAT
 * host, `/<slug>` is served by the `/s/<slug>` route handler. Everything the page itself needs
 * (the public lead-form API, Next internals, static files) passes through untouched. Any other
 * path on the pages host gets the neutral not-found page, never the app.
 *
 * PAGES_LEGACY_HOSTS (comma list of hosts or origins) names earlier pages hosts that keep
 * serving the same way after PAGES_BASE_URL moves (e.g. pages.crankleads.com → pages.everdoer.com),
 * so links already sent never break. The platform's own app/API hosts are never treated as a
 * pages host, even if listed by mistake.
 *
 * Imported by src/middleware.ts (edge runtime) — keep this file free of Node APIs; it imports
 * only the pure host list in rebrand/platform-hosts.ts.
 */

import { isNewPlatformHost, isOldPlatformHost } from "@/server/services/rebrand/platform-hosts";

/** Lower-cased host (with port) of PAGES_BASE_URL, or null when unset/invalid. */
export function pagesHostOf(pagesBaseUrl: string | null | undefined): string | null {
  const raw = pagesBaseUrl?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Lower-cased hosts (with port) listed in PAGES_LEGACY_HOSTS ("host" or "https://host"). PURE. */
export function pagesLegacyHostsOf(legacyHosts: string | null | undefined): string[] {
  return (legacyHosts ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      if (!entry.includes("://")) return entry.replace(/\/+$/, "");
      try {
        return new URL(entry).host.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter((host) => host && !isOldPlatformHost(host) && !isNewPlatformHost(host));
}

/**
 * Is `host` one of PAGES_LEGACY_HOSTS (and not the current PAGES_BASE_URL host)? The middleware
 * counts those requests as legacy host use. PURE.
 */
export function isLegacyPagesHost(
  host: string | null,
  pagesBaseUrl: string | null | undefined,
  legacyHosts: string | null | undefined,
): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === pagesHostOf(pagesBaseUrl)) return false;
  // Rebrand shim (remove in PR 8 once legacy_usage shows no host/<pages legacy host> for 30 days)
  return pagesLegacyHostsOf(legacyHosts).includes(h);
}

/**
 * The request's host — the Host header only. X-Forwarded-Host is client-controllable wherever
 * a proxy passes it through, and would let any request on the app host be treated as a pages-
 * host request (or vice versa). Railway's edge routes by Host and forwards it unchanged to the
 * service (it also overwrites X-Forwarded-Host with the same value), so Host is the one to
 * trust behind Railway; locally / in the e2e gateway Host is passed through as well.
 */
export function requestHost(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get("host");
  const first = raw?.split(",")[0]?.trim().toLowerCase();
  return first || null;
}

/** Paths on the pages host that are NOT a site slug and pass straight through. */
const PASSTHROUGH = [/^\/api\/public\/forms\//, /^\/_next\//, /^\/favicon\.ico$/, /^\/robots\.txt$/, /^\/s\//];

/**
 * Where a pages-host request should be rewritten to, or null to leave it alone.
 *   pages host + "/acme-snow"  → "/s/acme-snow"
 *   pages host + "/"           → "/s/_"  (the route's neutral 404 — no slug can be "_")
 *   pages host + "/acme-snow/jobs" (+ "/<job id>") → "/s/acme-snow/jobs…" (the Recruiter's jobs pages)
 *   pages host + "/acme-snow/plans" (+ "/<plan id>" | "/renew/<token>") → "/s/acme-snow/plans…" (Service plans)
 *   pages host + "/a/b"        → "/s/_"
 *   any other host             → null
 * A host in PAGES_LEGACY_HOSTS is served exactly like the PAGES_BASE_URL host.
 */
export function pagesRewritePath(
  host: string | null,
  pathname: string,
  pagesBaseUrl: string | null | undefined,
  legacyHosts?: string | null,
): string | null {
  if (!host) return null;
  const h = host.toLowerCase();
  const pagesHost = pagesHostOf(pagesBaseUrl);
  const onPagesHost = (pagesHost !== null && h === pagesHost) || isLegacyPagesHost(h, pagesBaseUrl, legacyHosts);
  if (!onPagesHost) return null;
  if (PASSTHROUGH.some((re) => re.test(pathname))) return null;
  const m = pathname.match(/^\/([a-z0-9-]{1,62})\/?$/);
  if (m) return `/s/${m[1]}`;
  const plans = pathname.match(/^\/([a-z0-9-]{1,62})\/plans(\/[0-9a-f-]{36}|\/renew\/[a-f0-9]{32})?\/?$/);
  if (plans) return `/s/${plans[1]}/plans${plans[2] ?? ""}`;
  const jobs = pathname.match(/^\/([a-z0-9-]{1,62})\/jobs(\/[0-9a-f-]{36})?\/?$/);
  return jobs ? `/s/${jobs[1]}/jobs${jobs[2] ?? ""}` : "/s/_";
}
