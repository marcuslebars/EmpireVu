/**
 * Server half of the platform brand (src/lib/platform-brand.ts holds the shared config).
 *
 * appBaseUrlFor(brand) is the ONE place an owner-/staff-facing link's origin comes from
 * (REBRAND_PLAN.md §3.2). Every org now shows Everdoer, and once EVERDOER_APP_BASE_URL is set
 * every org's links use it (app.everdoer.com). Until then nothing changes:
 *   - standard orgs: EVERDOER_APP_BASE_URL, else APP_BASE_URL (http://localhost:3000 when unset).
 *     The old CRANKLEADS_APP_BASE_URL is deliberately NOT a fallback here: it may point at
 *     app.crankleads.com, and house tenants (A1 etc.) were never sent there.
 *   - done-for-you orgs: EVERDOER_APP_BASE_URL, else the old CRANKLEADS_APP_BASE_URL (counted in
 *     legacy_usage), else APP_BASE_URL — exactly the PR 1 chain.
 *   Copy that names a host derives it from the link (never a hard-coded host).
 * Webhook/callback origins (Twilio, Retell, accounting OAuth) are NOT brand-dependent and
 * keep using APP_BASE_URL directly.
 *
 * Env: EVERDOER_APP_BASE_URL [web, workers] — the app origin for every org (no trailing slash);
 * old name CRANKLEADS_APP_BASE_URL still read for done-for-you orgs for one release. Note:
 * EVERDOER_APP_BASE_URL is also the target of the dormant legacy-host 301
 * (src/server/services/rebrand/legacy-hosts.ts), which needs EVERDOER_REDIRECT_LEGACY_HOSTS=1 too.
 */
import {
  brandForOrg,
  isDoneForYouBrand,
  platformBrand,
  PLATFORM_BRANDS,
  type PlatformBrand,
  type PlatformBrandKey,
} from "@/lib/platform-brand";
import type { ProductLine } from "@/lib/product-line";
import { envWithFallback } from "@/server/services/rebrand/legacy-usage";
import type { TenantServiceContext } from "@/server/services/shared";

export { brandForOrg, isDoneForYouBrand, platformBrand, PLATFORM_BRANDS };
export type { PlatformBrand, PlatformBrandKey };

/** A brand entry, or a stored platform_brand / product-line value. */
export type BrandRef = PlatformBrand | PlatformBrandKey | ProductLine | null | undefined;

function productLineOf(brand: BrandRef): ProductLine {
  if (!brand) return "standard";
  return typeof brand === "string" ? platformBrand(brand).productLine : brand.productLine;
}

/**
 * The configured Everdoer-era app origin for a product line, if any (no APP_BASE_URL fallback):
 * EVERDOER_APP_BASE_URL for everyone; done-for-you also reads the old CRANKLEADS_APP_BASE_URL.
 */
function everdoerAppBaseUrl(line: ProductLine): string | undefined {
  if (line === "done_for_you") {
    // Rebrand shim (remove in PR 8 once legacy_usage shows no env/CRANKLEADS_APP_BASE_URL for 30 days)
    return envWithFallback("EVERDOER_APP_BASE_URL", ["CRANKLEADS_APP_BASE_URL"]);
  }
  return process.env.EVERDOER_APP_BASE_URL?.trim() || undefined;
}

/** App origin (no trailing slash) for links sent to an org's own people. */
export function appBaseUrlFor(brand: BrandRef): string {
  const raw = everdoerAppBaseUrl(productLineOf(brand)) ?? process.env.APP_BASE_URL ?? "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/**
 * Like appBaseUrlFor, but null when no origin is configured for that product line (no
 * EVERDOER_APP_BASE_URL, no CRANKLEADS_APP_BASE_URL for done-for-you, and no APP_BASE_URL) —
 * for links that were simply omitted when APP_BASE_URL was unset.
 */
export function configuredAppBaseUrlFor(brand: BrandRef): string | null {
  const configured = everdoerAppBaseUrl(productLineOf(brand)) || process.env.APP_BASE_URL?.trim();
  return configured ? appBaseUrlFor(brand) : null;
}

/**
 * Like appBaseUrlFor, but with the caller's own fallback instead of APP_BASE_URL — for the few
 * links whose pre-rebrand origin wasn't APP_BASE_URL (Stripe Connect return URLs fall back to the
 * quote origin). EVERDOER_APP_BASE_URL (and, for done-for-you, CRANKLEADS_APP_BASE_URL) still wins.
 */
export function appBaseUrlOr(brand: BrandRef, fallback: string): string {
  return (everdoerAppBaseUrl(productLineOf(brand)) ?? fallback).replace(/\/+$/, "");
}

/** Host part of appBaseUrlFor(brand), for copy ("log in at <host>"). */
export function appHostFor(brand: BrandRef): string {
  const base = appBaseUrlFor(brand);
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/**
 * The brand entry of one org, read on the given client. Best-effort: a read failure falls back to
 * the standard line (never throws) — callers use it for copy and links, not access control.
 */
export async function loadOrganizationBrand(
  supabase: TenantServiceContext["supabase"],
  organizationId: string,
): Promise<PlatformBrand> {
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("platform_brand, crankleads_tier")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw error;
    return brandForOrg(data);
  } catch (err) {
    console.warn("[platform-brand] org brand read failed:", err instanceof Error ? err.message : err);
    return platformBrand(null);
  }
}
