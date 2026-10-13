/**
 * Everdoer rebrand (REBRAND_PLAN.md §3.4): the public done-for-you API answers on both
 *   /api/public/crankleads/<name>   (old; stays — links and the crankleads.com form use it)
 *   /api/public/everdoer/<name>     (new alias; src/app/api/public/everdoer/* re-exports the handlers)
 * The shared handlers call noteLegacyRoute() so a hit on the OLD path is counted (kind "route")
 * under a STABLE key: the route pattern, never the session id or token in the URL.
 *
 * Builders keep writing the old paths in PR 1 unless writeNewNames() is on.
 */
import { noteLegacyUsage } from "./legacy-usage";
import { writeNewNames } from "./write-names";

export const LEGACY_PUBLIC_PREFIX = "/api/public/crankleads/";
export const NEW_PUBLIC_PREFIX = "/api/public/everdoer/";

/**
 * Count the request if it arrived on the old /api/public/crankleads/ path. `routeKey` is the
 * route pattern under the prefix, e.g. "checkout/[sessionId]". Never throws.
 */
export function noteLegacyRoute(request: Request, routeKey: string): void {
  try {
    if (new URL(request.url).pathname.startsWith(LEGACY_PUBLIC_PREFIX)) {
      // Rebrand shim (remove in PR 8 once legacy_usage shows no route/<old path> for 30 days)
      noteLegacyUsage("route", `${LEGACY_PUBLIC_PREFIX}${routeKey}`, null);
    }
  } catch {
    /* counting never breaks a request */
  }
}

/** The public done-for-you API prefix builders write: old in PR 1, new once writeNewNames(). */
export function publicDoneForYouApiPrefix(env: Record<string, string | undefined> = process.env): string {
  return writeNewNames(env) ? NEW_PUBLIC_PREFIX : LEGACY_PUBLIC_PREFIX;
}
