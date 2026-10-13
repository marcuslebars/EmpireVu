/**
 * Server half of the platform brand (src/lib/platform-brand.ts holds the shared configs).
 *
 * appBaseUrlFor(brand) is the ONE place an owner-/staff-facing link's origin comes from:
 *   - EmpireVu orgs: APP_BASE_URL (unchanged behaviour; http://localhost:3000 when unset).
 *   - CrankLeads orgs: EVERDOER_APP_BASE_URL (old name CRANKLEADS_APP_BASE_URL, still read for
 *     one release) once it is set; until then the SAME origin as
 *     EmpireVu (APP_BASE_URL). So deploying this before app.crankleads.com exists never sends
 *     anyone to a dead host — CrankLeads users on the EmpireVu host still see CrankLeads
 *     (BrandProvider brands signed-in users by org, and the welcome page pins CrankLeads).
 *   Copy that names a host derives it from the link (never a hard-coded "app.crankleads.com").
 * Webhook/callback origins (Twilio, Retell, accounting OAuth) are NOT brand-dependent and
 * keep using APP_BASE_URL directly.
 *
 * Env: EVERDOER_APP_BASE_URL [web, workers] — the done-for-you app origin (no trailing slash);
 * old name CRANKLEADS_APP_BASE_URL still read for one release. EmpireVu orgs keep APP_BASE_URL
 * in PR 1. Note: EVERDOER_APP_BASE_URL is also the target of the dormant legacy-host 301
 * (src/server/services/rebrand/legacy-hosts.ts), which needs EVERDOER_REDIRECT_LEGACY_HOSTS=1 too.
 */
import {
  brandForOrg,
  platformBrand,
  PLATFORM_BRANDS,
  type PlatformBrand,
  type PlatformBrandKey,
} from "@/lib/platform-brand";
import { envWithFallback } from "@/server/services/rebrand/legacy-usage";
import type { TenantServiceContext } from "@/server/services/shared";

export { brandForOrg, platformBrand, PLATFORM_BRANDS };
export type { PlatformBrand, PlatformBrandKey };

/** The done-for-you app origin from env, if configured. */
function doneForYouAppBaseUrl(): string | undefined {
  // Rebrand shim (remove in PR 8 once legacy_usage shows no env/CRANKLEADS_APP_BASE_URL for 30 days)
  return envWithFallback("EVERDOER_APP_BASE_URL", ["CRANKLEADS_APP_BASE_URL"]);
}

/** App origin (no trailing slash) for links sent to an org's own people. */
export function appBaseUrlFor(brand: PlatformBrand | PlatformBrandKey | null | undefined): string {
  const key = typeof brand === "string" ? brand : brand?.key ?? "empirevu";
  const raw =
    key === "crankleads"
      ? doneForYouAppBaseUrl() ?? process.env.APP_BASE_URL ?? "http://localhost:3000"
      : process.env.APP_BASE_URL ?? "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/**
 * Like appBaseUrlFor, but null when no origin is configured for that brand (neither
 * EVERDOER_APP_BASE_URL / CRANKLEADS_APP_BASE_URL for CrankLeads nor APP_BASE_URL) — for links that were simply
 * omitted when APP_BASE_URL was unset.
 */
export function configuredAppBaseUrlFor(brand: PlatformBrand | PlatformBrandKey | null | undefined): string | null {
  const key = typeof brand === "string" ? brand : brand?.key ?? "empirevu";
  const configured = (key === "crankleads" && doneForYouAppBaseUrl()) || process.env.APP_BASE_URL?.trim();
  return configured ? appBaseUrlFor(key) : null;
}

/** Host part of appBaseUrlFor(brand), for copy ("log in at <host>"). */
export function appHostFor(brand: PlatformBrand | PlatformBrandKey): string {
  const base = appBaseUrlFor(brand);
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/**
 * The brand of one org, read on the given client. Best-effort: a read failure falls back to
 * EmpireVu (never throws) — callers use it for copy and links, not access control.
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
