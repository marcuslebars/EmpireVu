/**
 * Server half of the platform brand (src/lib/platform-brand.ts holds the shared configs).
 *
 * appBaseUrlFor(brand) is the ONE place an owner-/staff-facing link's origin comes from:
 *   - EmpireVu orgs: APP_BASE_URL (unchanged behaviour; http://localhost:3000 when unset).
 *   - CrankLeads orgs: CRANKLEADS_APP_BASE_URL, default https://app.crankleads.com.
 * Webhook/callback origins (Twilio, Retell, accounting OAuth) are NOT brand-dependent and
 * keep using APP_BASE_URL directly.
 *
 * Env: CRANKLEADS_APP_BASE_URL [web, workers] — the CrankLeads app origin (no trailing slash).
 */
import {
  brandForOrg,
  platformBrand,
  PLATFORM_BRANDS,
  type PlatformBrand,
  type PlatformBrandKey,
} from "@/lib/platform-brand";
import type { TenantServiceContext } from "@/server/services/shared";

export { brandForOrg, platformBrand, PLATFORM_BRANDS };
export type { PlatformBrand, PlatformBrandKey };

function trimmed(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** App origin (no trailing slash) for links sent to an org's own people. */
export function appBaseUrlFor(brand: PlatformBrand | PlatformBrandKey | null | undefined): string {
  const key = typeof brand === "string" ? brand : brand?.key ?? "empirevu";
  const raw =
    key === "crankleads"
      ? trimmed("CRANKLEADS_APP_BASE_URL") ?? PLATFORM_BRANDS.crankleads.defaultAppBaseUrl
      : process.env.APP_BASE_URL ?? "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/** Host part of appBaseUrlFor(brand), for copy ("log in at app.crankleads.com"). */
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
