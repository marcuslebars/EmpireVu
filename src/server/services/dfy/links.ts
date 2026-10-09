/**
 * Done-for-you links. Buyer-facing pages live on the CrankLeads app host
 * (appBaseUrlFor("crankleads")); the concierge console is operator-only, on the house app
 * origin (APP_BASE_URL). Generated-site URLs come from ONE helper: siteUrl(slug, brand) in
 * dfy/site-url.ts (PAGES_BASE_URL/<slug>, else <app>/s/<slug>).
 */
import { getAppBaseUrl } from "@/server/services/billing/env";
import { appBaseUrlFor } from "@/server/services/platform-brand";

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}

export function buyerAppUrl(): string {
  return trim(appBaseUrlFor("crankleads"));
}

/** The intake builder's no-login 60-second quick setup page. */
export function quickSetupUrl(token: string): string {
  return `${buyerAppUrl()}/setup/${encodeURIComponent(token)}`;
}

/** The one-tap forwarding page (no login; the token is the credential). */
export function forwardPageUrl(token: string): string {
  return `${buyerAppUrl()}/forward/${encodeURIComponent(token)}`;
}

/** Operator concierge console for an org (route owned by the console builder). */
export function conciergeUrl(organizationId: string): string {
  return `${trim(getAppBaseUrl())}/concierge/${encodeURIComponent(organizationId)}`;
}
