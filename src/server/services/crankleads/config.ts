/**
 * CrankLeads offer → EmpireVu configuration. The ONE place that maps a CrankLeads tier
 * (what the buyer picked on crankleads.com) onto an EmpireVu plan, Stripe price ids,
 * industry pack and starter automations.
 *
 * NO DOLLAR AMOUNTS (Working Protocol #4). The CrankLeads prices (CAD setup fee + monthly)
 * live in Stripe — created by `npm run stripe:setup-crankleads` — and are referenced here
 * only by their Price ids from env.
 *
 * CrankLeads is the offer; EmpireVu is the product the buyer logs into. Nothing here
 * rebrands the app.
 */
import type { PurchasablePlan } from "@/server/services/billing/config";
import { EVERDOER_BRAND, EVERDOER_COLORS } from "@/lib/platform-brand";
import { appBaseUrlFor } from "@/server/services/platform-brand";
import { envWithFallback } from "@/server/services/rebrand/legacy-usage";

export const CRANKLEADS_TIERS = ["catch", "close", "front_desk"] as const;
export type CrankleadsTier = (typeof CRANKLEADS_TIERS)[number];

export function isCrankleadsTier(value: unknown): value is CrankleadsTier {
  return typeof value === "string" && (CRANKLEADS_TIERS as readonly string[]).includes(value);
}

/** Display name of the purchased offer (emails, SMS, operator mail). Everdoer since PR 2; the identifier is renamed in PR 5. */
export const CRANKLEADS_OFFER_NAME = "Everdoer";

export const CRANKLEADS_TIER_LABELS: Record<CrankleadsTier, string> = {
  catch: "Catch",
  close: "Close",
  front_desk: "Front Desk",
};

/**
 * Tier → EmpireVu plan. Catch needs workflows + SMS (missed-call text-back, instant replies),
 * which `launch` lacks, so Catch and Close both run on `operate`. Only Front Desk includes
 * the AI receptionist (`marina_reception`, 500 included minutes — billing/config.ts).
 */
export const CRANKLEADS_TIER_PLAN: Record<CrankleadsTier, PurchasablePlan> = {
  catch: "operate",
  close: "operate",
  front_desk: "front_desk",
};

/** Stripe metadata `source` stamped on every CrankLeads Checkout Session + Subscription. */
export const CRANKLEADS_SOURCE = "crankleads";

// ── Stripe price ids (env only) ───────────────────────────────────────────────

/**
 * Everdoer rebrand: each setting is read by its new name first (STRIPE_*_EVERDOER_*,
 * EVERDOER_*), then the old STRIPE_*_CL_* / CRANKLEADS_* name (counted once per process as kind
 * "env"). `npm run stripe:setup-crankleads` still prints the old names in PR 1.
 */
export const ENV_RENAMES = {
  STRIPE_PRICE_EVERDOER_CATCH: ["STRIPE_PRICE_CL_CATCH"],
  STRIPE_PRICE_EVERDOER_CLOSE: ["STRIPE_PRICE_CL_CLOSE"],
  STRIPE_PRICE_EVERDOER_FRONT_DESK: ["STRIPE_PRICE_CL_FRONT_DESK"],
  STRIPE_SETUP_FEE_EVERDOER_CATCH: ["STRIPE_SETUP_FEE_CL_CATCH"],
  STRIPE_SETUP_FEE_EVERDOER_CLOSE: ["STRIPE_SETUP_FEE_CL_CLOSE"],
  STRIPE_SETUP_FEE_EVERDOER_FRONT_DESK: ["STRIPE_SETUP_FEE_CL_FRONT_DESK"],
  STRIPE_COUPON_EVERDOER_FOUNDING: ["STRIPE_COUPON_CL_FOUNDING"],
  EVERDOER_SITE_ORIGINS: ["CRANKLEADS_SITE_ORIGINS"],
  EVERDOER_CANCEL_URL: ["CRANKLEADS_CANCEL_URL"],
  EVERDOER_CHECKOUT_DISPLAY_NAME: ["CRANKLEADS_CHECKOUT_DISPLAY_NAME"],
  EVERDOER_CHECKOUT_LOGO_URL: ["CRANKLEADS_CHECKOUT_LOGO_URL"],
  EVERDOER_CHECKOUT_BACKGROUND_COLOR: ["CRANKLEADS_CHECKOUT_BACKGROUND_COLOR"],
  EVERDOER_CHECKOUT_BUTTON_COLOR: ["CRANKLEADS_CHECKOUT_BUTTON_COLOR"],
} as const satisfies Record<string, readonly string[]>;
type RenamedEnv = keyof typeof ENV_RENAMES;

const MONTHLY_PRICE_ENV: Record<CrankleadsTier, RenamedEnv> = {
  catch: "STRIPE_PRICE_EVERDOER_CATCH",
  close: "STRIPE_PRICE_EVERDOER_CLOSE",
  front_desk: "STRIPE_PRICE_EVERDOER_FRONT_DESK",
};

const SETUP_PRICE_ENV: Record<CrankleadsTier, RenamedEnv> = {
  catch: "STRIPE_SETUP_FEE_EVERDOER_CATCH",
  close: "STRIPE_SETUP_FEE_EVERDOER_CLOSE",
  front_desk: "STRIPE_SETUP_FEE_EVERDOER_FRONT_DESK",
};

function envValue(name: RenamedEnv): string | null {
  // Rebrand shim (remove in PR 8 once legacy_usage shows no env/<old name> for 30 days)
  return envWithFallback(name, ENV_RENAMES[name]) ?? null;
}

/** The tier's recurring monthly Price id, or null when its env var is unset. */
export function crankleadsMonthlyPriceId(tier: CrankleadsTier): string | null {
  return envValue(MONTHLY_PRICE_ENV[tier]);
}

/** The tier's one-time setup-fee Price id, or null when its env var is unset. */
export function crankleadsSetupPriceId(tier: CrankleadsTier): string | null {
  return envValue(SETUP_PRICE_ENV[tier]);
}

/** Optional founding-client coupon id (applies to the setup fee only — see the setup script). */
export function crankleadsFoundingCouponId(): string | null {
  return envValue("STRIPE_COUPON_EVERDOER_FOUNDING");
}

/** Reverse map: a CrankLeads monthly Price id → its tier, or null. */
export function crankleadsTierForPriceId(priceId: string | null | undefined): CrankleadsTier | null {
  if (!priceId) return null;
  for (const tier of CRANKLEADS_TIERS) {
    if (crankleadsMonthlyPriceId(tier) === priceId) return tier;
  }
  return null;
}

/** A CrankLeads monthly Price id → the EmpireVu plan it buys, or null (used by billing/env.ts). */
export function crankleadsPlanForPriceId(priceId: string | null | undefined): PurchasablePlan | null {
  const tier = crankleadsTierForPriceId(priceId);
  return tier ? CRANKLEADS_TIER_PLAN[tier] : null;
}

// ── Public site + checkout settings ───────────────────────────────────────────

const DEFAULT_SITE_ORIGINS = "https://crankleads.com,https://www.crankleads.com,https://everdoer.com,https://www.everdoer.com";
const DEFAULT_CANCEL_URL = "https://crankleads.com/#pricing";

/**
 * Origins allowed to call the public checkout endpoint (CORS). Env EVERDOER_SITE_ORIGINS (old
 * name CRANKLEADS_SITE_ORIGINS still read for one release). The default includes everdoer.com
 * and www.everdoer.com alongside today's crankleads.com origins.
 */
export function crankleadsSiteOrigins(): Set<string> {
  const raw = envValue("EVERDOER_SITE_ORIGINS") || DEFAULT_SITE_ORIGINS;
  return new Set(
    raw
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

export function crankleadsCancelUrl(): string {
  return envValue("EVERDOER_CANCEL_URL") || DEFAULT_CANCEL_URL;
}

/** Stripe Tax on the Checkout Session — OFF unless STRIPE_AUTOMATIC_TAX=true (HST is a manual follow-up). */
export function crankleadsAutomaticTax(): boolean {
  return process.env.STRIPE_AUTOMATIC_TAX?.trim().toLowerCase() === "true";
}

// ── Checkout branding ─────────────────────────────────────────────────────────

/**
 * Per-session Stripe Checkout branding, so a buyer (and, since PR 2, every org's billing
 * checkout) sees Everdoer — not the Stripe account's own EmpireVu name/logo — at the top of the
 * payment page. The account's legal business name still appears in Stripe's terms text, receipts
 * and the card statement descriptor — Stripe does not allow overriding those per session.
 * The default logo is the app's own copy of the brand kit PNG
 * (`<app origin>/brand/everdoer/everdoer-logo-dark.png`); Stripe needs an https URL, so a
 * non-https origin (local dev) falls back to the old crankleads.com image.
 */
export interface CrankleadsCheckoutBranding {
  displayName: string;
  logoUrl: string;
  backgroundColor: string;
  buttonColor: string;
}

const DEFAULT_CHECKOUT_DISPLAY_NAME = EVERDOER_BRAND.name;
/** Last resort when the app origin isn't https (local dev): Stripe rejects non-https logo URLs. */
const LEGACY_CHECKOUT_LOGO_URL = "https://crankleads.com/brand/crankleads-logo.png";
/** Everdoer background + accent (brand kit). */
const DEFAULT_CHECKOUT_BACKGROUND = EVERDOER_COLORS.nearBlack;
const DEFAULT_CHECKOUT_BUTTON = EVERDOER_COLORS.lime;

/** The brand-kit logo served by the app itself, when the app origin is https. */
function defaultCheckoutLogoUrl(): string {
  const base = appBaseUrlFor("done_for_you");
  return base.startsWith("https://") ? `${base}/brand/everdoer/everdoer-logo-dark.png` : LEGACY_CHECKOUT_LOGO_URL;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function hexOr(name: RenamedEnv, fallback: string): string {
  const value = envValue(name);
  return value && HEX_COLOR.test(value) ? value : fallback;
}

function httpsUrlOr(name: RenamedEnv, fallback: string): string {
  const value = envValue(name);
  return value && value.startsWith("https://") ? value : fallback;
}

export function crankleadsCheckoutBranding(): CrankleadsCheckoutBranding {
  return {
    displayName: envValue("EVERDOER_CHECKOUT_DISPLAY_NAME") ?? DEFAULT_CHECKOUT_DISPLAY_NAME,
    logoUrl: httpsUrlOr("EVERDOER_CHECKOUT_LOGO_URL", defaultCheckoutLogoUrl()),
    backgroundColor: hexOr("EVERDOER_CHECKOUT_BACKGROUND_COLOR", DEFAULT_CHECKOUT_BACKGROUND),
    buttonColor: hexOr("EVERDOER_CHECKOUT_BUTTON_COLOR", DEFAULT_CHECKOUT_BUTTON),
  };
}

// ── Business type → industry pack ─────────────────────────────────────────────

/** The business types offered on the crankleads.com form. */
export const CRANKLEADS_BUSINESS_TYPES = [
  "Property maintenance & snow",
  "Landscaping",
  "Roofing",
  "HVAC & plumbing",
  "Contracting & renovation",
  "Marine",
  "Auto detailing",
  "Cleaning",
  "Other",
] as const;

const BUSINESS_TYPE_PACK: Record<string, string | null> = {
  "property maintenance & snow": "property-maintenance-snow",
  landscaping: "landscaping",
  roofing: "roofing",
  "hvac & plumbing": "hvac-plumbing",
  "contracting & renovation": "general-contractor",
  marine: "marine",
  "auto detailing": null,
  cleaning: null,
  other: null,
};

/** The industry pack id for a crankleads.com business type, or null (generic — no pack). */
export function packIdForBusinessType(businessType: string): string | null {
  const key = businessType.trim().toLowerCase().replace(/\s+/g, " ");
  return BUSINESS_TYPE_PACK[key] ?? null;
}

// ── Starter automations per tier ──────────────────────────────────────────────

/**
 * The AI-receptionist automations — they react to calls Marina answers (call summaries,
 * the post-call quote text, urgent-call escalation …). Front Desk only.
 */
export const RECEPTIONIST_RECIPE_SLUGS: readonly string[] = [
  "call-summary-to-owner",
  "missed-call-summary-to-owner",
  "post-call-quote-text",
  "urgent-call-escalation",
  "call-started-to-owner",
  "call-abandoned-recovery-text",
];

/**
 * Catch: missed-call text-back, the new-lead owner alert (the instant "new lead" ping),
 * booking reminders, and customer-reply forwarding (so a caller who answers the text-back
 * reaches the owner).
 */
export const CATCH_RECIPE_SLUGS: readonly string[] = [
  "missed-call-text-back",
  "new-lead-owner-alert",
  "booking-reminder",
  "customer-text-to-owner",
];

/** Close adds the follow-up automations that turn quotes and no-shows into jobs. */
export const CLOSE_EXTRA_RECIPE_SLUGS: readonly string[] = [
  "quote-follow-up",
  "stale-lead-nudge",
  "no-show-recovery",
  "invoice-paid-owner-alert",
  "invoice-overdue-owner-alert",
];

/**
 * The automations a tier gets switched on. Catch: text-back + lead alerts + reminders.
 * Close: + quote / lead / no-show follow-ups and invoice alerts. Front Desk: + the AI
 * receptionist ones.
 */
export function dfyRecipeSlugs(tier: CrankleadsTier): string[] {
  const slugs = [...CATCH_RECIPE_SLUGS];
  if (tier !== "catch") slugs.push(...CLOSE_EXTRA_RECIPE_SLUGS);
  if (tier === "front_desk") slugs.push(...RECEPTIONIST_RECIPE_SLUGS);
  return Array.from(new Set(slugs));
}

/**
 * Every recipe a CrankLeads company on this tier may have ACTIVE: the tier's pack recipes
 * (packRecipesForTier) plus the tier's switch-on set (dfyRecipeSlugs). Anything else the
 * recipe catalog installed (e.g. stale-lead-nudge on a Catch buyer) stays draft.
 */
export function tierAllowedRecipeSlugs(tier: CrankleadsTier, packRecipeSlugs: readonly string[]): Set<string> {
  return new Set([...packRecipesForTier(tier, packRecipeSlugs), ...dfyRecipeSlugs(tier)]);
}

/**
 * Which of a pack's recipes to tailor for a tier: Catch → the Catch set; Close → every pack
 * recipe except the receptionist ones; Front Desk → every pack recipe.
 */
export function packRecipesForTier(tier: CrankleadsTier, packRecipeSlugs: readonly string[]): string[] {
  if (tier === "front_desk") return [...packRecipeSlugs];
  if (tier === "catch") return packRecipeSlugs.filter((slug) => CATCH_RECIPE_SLUGS.includes(slug));
  return packRecipeSlugs.filter((slug) => !RECEPTIONIST_RECIPE_SLUGS.includes(slug));
}
