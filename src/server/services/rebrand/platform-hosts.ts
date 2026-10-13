/**
 * Everdoer rebrand (decision D1): the platform's OWN app/API hosts, old and new. Used where a
 * wire contract with an outside system depends on the host: Twilio voice signatures (which
 * cover the full URL) and the provider re-point jobs.
 *
 * Tenant hosts (quotes.a1marinecare.ca, quotes.a1marinestorage.ca, …) are deliberately NOT here
 * and must never be added: nothing in the rebrand may re-point or rewrite a tenant's URLs.
 * Marketing hosts (empirevu.com, crankleads.com, everdoer.com) are not here either: no provider
 * webhook points at them.
 */

/** Old app/API hosts that provider configs (Twilio numbers, Retell agents) may still point at. */
export const OLD_PLATFORM_HOSTS = ["app.empirevu.com", "api.empirevu.com", "app.crankleads.com"] as const;

/** New app/API hosts (same service). */
export const NEW_PLATFORM_HOSTS = ["app.everdoer.com", "api.everdoer.com"] as const;

export const PLATFORM_HOSTS: readonly string[] = [...OLD_PLATFORM_HOSTS, ...NEW_PLATFORM_HOSTS];

/** Is `host` (a hostname, any case, optional :port) one of the OLD platform hosts? PURE. */
export function isOldPlatformHost(host: string | null | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  return (OLD_PLATFORM_HOSTS as readonly string[]).includes(h);
}

/** Is `host` one of the NEW platform hosts? PURE. */
export function isNewPlatformHost(host: string | null | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  return (NEW_PLATFORM_HOSTS as readonly string[]).includes(h);
}
