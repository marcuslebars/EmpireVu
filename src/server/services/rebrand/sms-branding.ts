/**
 * Everdoer rebrand: the ONE switch for platform names inside SMS text (REBRAND_PLAN.md §1.3).
 *
 * A2P 10DLC: live traffic must match the campaign's registered sample messages and brand, so no
 * SMS text changes until the owner has updated them. With EVERDOER_SMS_BRANDING off (default)
 * every SMS is byte-identical to before the rebrand:
 *   - owner texts: "CrankLeads: " for done-for-you orgs, no prefix for other orgs;
 *   - platform-number unknown-sender / HELP replies: the CrankLeads text;
 *   - done-for-you setup / reminder / "you're live" / forwarding texts and the weekly report text:
 *     "CrankLeads" (standard orgs' weekly text: EVERDOER_BRAND_NAME (old: PLATFORM_BRAND_NAME), else "EmpireVu").
 * With it on (EVERDOER_SMS_BRANDING=1 [web, worker, billing-worker]): "Everdoer" everywhere,
 * and owner texts are signed "Everdoer: " for EVERY org.
 *
 * Emails, pages and the app are NOT gated by this: they say Everdoer already.
 */
import type { ProductLine } from "@/lib/product-line";

export const EVERDOER_SMS_NAME = "Everdoer";
/** The done-for-you product's name in SMS before the switch (A2P samples registered with it). */
export const LEGACY_DFY_SMS_NAME = "CrankLeads";
/** The standard product's name in SMS before the switch. */
export const LEGACY_STANDARD_SMS_NAME = "EmpireVu";

export function smsBrandingOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.EVERDOER_SMS_BRANDING?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** The platform name to put inside an SMS for an org on this product line. */
export function smsPlatformName(line: ProductLine, env: Record<string, string | undefined> = process.env): string {
  if (smsBrandingOn(env)) return EVERDOER_SMS_NAME;
  if (line === "done_for_you") return LEGACY_DFY_SMS_NAME;
  // EVERDOER_BRAND_NAME first; PLATFORM_BRAND_NAME is its old name (same as monthly-scorecard/platform-brand.ts).
  return env.EVERDOER_BRAND_NAME?.trim() || env.PLATFORM_BRAND_NAME?.trim() || LEGACY_STANDARD_SMS_NAME;
}
