/**
 * Host-based serving for generated sites (docs/done-for-you.md → "Generated sites").
 *
 * When PAGES_BASE_URL is set (e.g. https://pages.crankleads.com) and a request arrives on THAT
 * host, `/<slug>` is served by the `/s/<slug>` route handler. Everything the page itself needs
 * (the public lead-form API, Next internals, static files) passes through untouched. Any other
 * path on the pages host gets the neutral not-found page, never the app.
 *
 * Imported by src/middleware.ts (edge runtime) — keep this file free of Node APIs and imports.
 */

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

/** The request's host: x-forwarded-host (first value) when present, else Host. */
export function requestHost(headers: { get(name: string): string | null }): string | null {
  const raw = headers.get("x-forwarded-host") ?? headers.get("host");
  const first = raw?.split(",")[0]?.trim().toLowerCase();
  return first || null;
}

/** Paths on the pages host that are NOT a site slug and pass straight through. */
const PASSTHROUGH = [/^\/api\/public\/forms\//, /^\/_next\//, /^\/favicon\.ico$/, /^\/robots\.txt$/, /^\/s\//];

/**
 * Where a pages-host request should be rewritten to, or null to leave it alone.
 *   pages host + "/acme-snow"  → "/s/acme-snow"
 *   pages host + "/"           → "/s/_"  (the route's neutral 404 — no slug can be "_")
 *   pages host + "/a/b"        → "/s/_"
 *   any other host             → null
 */
export function pagesRewritePath(host: string | null, pathname: string, pagesBaseUrl: string | null | undefined): string | null {
  const pagesHost = pagesHostOf(pagesBaseUrl);
  if (!pagesHost || !host || host.toLowerCase() !== pagesHost) return null;
  if (PASSTHROUGH.some((re) => re.test(pathname))) return null;
  const m = pathname.match(/^\/([a-z0-9-]{1,62})\/?$/);
  return m ? `/s/${m[1]}` : "/s/_";
}
