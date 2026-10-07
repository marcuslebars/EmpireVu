// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): public CrankLeads checkout.
// POST /api/public/crankleads/checkout is called by crankleads.com with NO session — the
// buyer has no account yet — so there is no RLS identity. This module writes only the
// service-role-only staging table crankleads_purchases (via ./purchases.ts) and creates a
// Stripe Checkout Session from env price ids. It never reads or writes tenant data; the
// tier/price can only be one of the three configured CrankLeads prices.
// Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import type Stripe from "stripe";
import { z } from "zod";

import { appBaseUrlFor } from "@/server/services/platform-brand";
import { getStripeClient } from "@/server/services/billing/stripe";
import {
  CRANKLEADS_SOURCE,
  CRANKLEADS_TIER_PLAN,
  CRANKLEADS_TIERS,
  crankleadsAutomaticTax,
  crankleadsCancelUrl,
  crankleadsCheckoutBranding,
  crankleadsFoundingCouponId,
  crankleadsMonthlyPriceId,
  crankleadsSetupPriceId,
} from "@/server/services/crankleads/config";
import {
  findPurchaseBySession,
  insertPurchase,
  maskEmail,
  updatePurchase,
  type AdminClient,
  type CrankleadsPurchase,
} from "@/server/services/crankleads/purchases";

/** Hard cap on the request body (bytes). The real payload is well under 2 KB. */
export const CRANKLEADS_CHECKOUT_MAX_BODY_BYTES = 8 * 1024;

const MAX_UTM_KEYS = 10;
const MAX_UTM_KEY = 40;
const MAX_UTM_VALUE = 200;
/** Stripe metadata values are capped at 500 chars. */
const STRIPE_METADATA_VALUE_MAX = 500;

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const crankleadsCheckoutSchema = z.object({
  tier: z.enum(CRANKLEADS_TIERS),
  name: trimmed(200),
  email: z.string().trim().toLowerCase().email().max(320),
  phone: z
    .string()
    .trim()
    .min(7)
    .max(40)
    .refine((value) => value.replace(/\D/g, "").length >= 10, "Enter a 10-digit phone number."),
  businessName: trimmed(200),
  businessType: trimmed(100),
  founding: z.boolean().optional(),
  utm: z.record(z.string(), z.string()).optional(),
});

export type CrankleadsCheckoutInput = z.infer<typeof crankleadsCheckoutSchema>;

/** Keep at most 10 utm keys with bounded lengths (it lands in Stripe metadata). */
export function sanitizeUtm(utm: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(utm ?? {})) {
    if (Object.keys(out).length >= MAX_UTM_KEYS) break;
    const k = key.trim().slice(0, MAX_UTM_KEY);
    if (!k) continue;
    out[k] = String(value).trim().slice(0, MAX_UTM_VALUE);
  }
  return out;
}

function truncate(value: string, max = STRIPE_METADATA_VALUE_MAX): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** utm JSON for Stripe metadata — never longer than Stripe's 500-char value limit. */
export function utmMetadata(utm: Record<string, string>): string {
  const json = JSON.stringify(utm);
  if (json.length <= STRIPE_METADATA_VALUE_MAX) return json;
  // Drop keys from the end until it fits (a cut-off JSON string would be useless).
  const entries = Object.entries(utm);
  while (entries.length > 0) {
    entries.pop();
    const candidate = JSON.stringify(Object.fromEntries(entries));
    if (candidate.length <= STRIPE_METADATA_VALUE_MAX) return candidate;
  }
  return "{}";
}

export class CrankleadsCheckoutUnavailableError extends Error {}

/**
 * Session params plus `managed_payments`, which this stripe SDK version doesn't type yet.
 *
 * The account has Stripe Managed Payments (Stripe as merchant of record) ON by default.
 * It only supports digital products and rejects `automatic_tax`; CrankLeads includes a
 * done-for-you setup service and EmpireVu runs its own invoicing, so every CrankLeads
 * session opts out explicitly. HST is then handled by `automatic_tax` (Stripe Tax) when
 * STRIPE_AUTOMATIC_TAX=true. See docs/crankleads-purchase.md.
 */
export type CrankleadsSessionCreateParams = Stripe.Checkout.SessionCreateParams & {
  managed_payments: { enabled: boolean };
};

/** The exact Stripe Checkout Session params for a staged purchase (pure — golden-tested). */
export function buildCrankleadsSessionParams(
  purchase: Pick<CrankleadsPurchase, "id">,
  input: CrankleadsCheckoutInput,
  utm: Record<string, string>,
  /** A coupon already verified usable (founding offer), or null. */
  coupon: string | null,
): CrankleadsSessionCreateParams {
  const monthly = crankleadsMonthlyPriceId(input.tier);
  const setup = crankleadsSetupPriceId(input.tier);
  if (!monthly || !setup) {
    throw new CrankleadsCheckoutUnavailableError(
      `CrankLeads ${input.tier} prices are not configured (STRIPE_PRICE_CL_* / STRIPE_SETUP_FEE_CL_*).`,
    );
  }

  const metadata: Record<string, string> = {
    source: CRANKLEADS_SOURCE,
    purchaseId: purchase.id,
    tier: input.tier,
    plan: CRANKLEADS_TIER_PLAN[input.tier],
    businessName: truncate(input.businessName),
    businessType: truncate(input.businessType),
    ownerName: truncate(input.name),
    ownerPhone: truncate(input.phone),
    utm: utmMetadata(utm),
  };

  // After paying, the buyer lands on the CrankLeads app host (CRANKLEADS_APP_BASE_URL) — the
  // same host their welcome email and every later link uses (docs/crankleads-branding.md).
  const base = appBaseUrlFor("crankleads");
  const brand = crankleadsCheckoutBranding();

  // Subscription mode with BOTH prices: the recurring monthly price becomes the
  // subscription; the one-time setup price rides on the first invoice only (Stripe
  // Checkout `line_items` docs: "Line items with one-time Prices will be on the initial
  // invoice only").
  return {
    mode: "subscription",
    line_items: [
      { price: monthly, quantity: 1 },
      { price: setup, quantity: 1 },
    ],
    customer_email: input.email,
    client_reference_id: purchase.id,
    currency: "cad",
    billing_address_collection: "required",
    automatic_tax: { enabled: crankleadsAutomaticTax() },
    managed_payments: { enabled: false },
    // The buyer bought CrankLeads: brand the payment page as CrankLeads, not the account's
    // EmpireVu default (Stripe allows a logo OR an icon, not both — the wordmark logo).
    branding_settings: {
      display_name: brand.displayName,
      logo: { type: "url", url: brand.logoUrl },
      background_color: brand.backgroundColor,
      button_color: brand.buttonColor,
      font_family: "inter",
      border_style: "rounded",
    },
    // Only our server-side founding coupon can discount a CrankLeads checkout — no
    // promotion-code box (any active promo code in the account would otherwise apply).
    ...(coupon ? { discounts: [{ coupon }] } : { allow_promotion_codes: false }),
    metadata,
    subscription_data: { metadata },
    success_url: `${base}/welcome/crankleads?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: crankleadsCancelUrl(),
  };
}

/**
 * Stage the purchase (durable-first), open the Stripe Checkout Session, and remember its id.
 * If remembering the id fails the purchase is still found later by client_reference_id /
 * metadata.purchaseId, so the buyer is never blocked on it.
 */
export async function createCrankleadsCheckout(
  admin: AdminClient,
  input: CrankleadsCheckoutInput,
  stripe: Stripe = getStripeClient(),
): Promise<{ url: string; sessionId: string; purchaseId: string }> {
  // Fail fast (before staging anything) when the tier's prices aren't configured.
  if (!crankleadsMonthlyPriceId(input.tier) || !crankleadsSetupPriceId(input.tier)) {
    throw new CrankleadsCheckoutUnavailableError(`CrankLeads ${input.tier} prices are not configured.`);
  }

  const utm = sanitizeUtm(input.utm);
  const purchase = await insertPurchase(admin, {
    tier: input.tier,
    ownerName: input.name,
    ownerEmail: input.email,
    ownerPhone: input.phone,
    businessName: input.businessName,
    businessType: input.businessType,
    founding: Boolean(input.founding),
    utm,
  });

  const coupon = input.founding ? await usableFoundingCoupon(stripe) : null;
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(buildCrankleadsSessionParams(purchase, input, utm, coupon), {
      idempotencyKey: `crankleads-checkout-${purchase.id}`,
    });
  } catch (err) {
    if (!coupon) throw err;
    // The founding coupon went invalid between the check and the create (e.g. the last
    // redemption raced us): sell at full price rather than failing the checkout.
    console.warn(
      `[crankleads/checkout] session with founding coupon ${coupon} failed (${err instanceof Error ? err.message : err}); retrying without it`,
    );
    session = await stripe.checkout.sessions.create(buildCrankleadsSessionParams(purchase, input, utm, null), {
      idempotencyKey: `crankleads-checkout-${purchase.id}-nodiscount`,
    });
  }
  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL.");
  }

  try {
    await updatePurchase(admin, purchase.id, { stripe_checkout_session_id: session.id });
  } catch (err) {
    console.error(
      `[crankleads/checkout] could not record session ${session.id} on purchase ${purchase.id} ` +
        `(the worker will match it by client_reference_id):`,
      err instanceof Error ? err.message : err,
    );
  }

  return { url: session.url, sessionId: session.id, purchaseId: purchase.id };
}

/**
 * The founding coupon id when it is configured AND still redeemable in Stripe (valid, not
 * exhausted). Exhausted / deleted / unreachable → null: the checkout goes ahead at full price
 * instead of failing (the `founding` flag comes from the public form, so it must never be able
 * to break sales).
 */
export async function usableFoundingCoupon(stripe: Stripe): Promise<string | null> {
  const id = crankleadsFoundingCouponId();
  if (!id) return null;
  try {
    const coupon = await stripe.coupons.retrieve(id);
    if (coupon.valid) return id;
    console.warn(`[crankleads/checkout] founding coupon ${id} is no longer valid (exhausted or expired); full price`);
  } catch (err) {
    console.warn(`[crankleads/checkout] founding coupon ${id} lookup failed (${err instanceof Error ? err.message : err}); full price`);
  }
  return null;
}

export type PublicPurchaseStatus = "pending" | "provisioning" | "ready" | "failed";

export interface PublicPurchaseView {
  status: PublicPurchaseStatus;
  businessName: string;
  emailMasked: string;
}

/** Collapse the internal status machine to what the buyer's welcome page needs. */
export function publicStatusOf(status: string): PublicPurchaseStatus {
  switch (status) {
    case "provisioned":
      return "ready";
    case "paid":
    case "provisioning":
      return "provisioning";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/** The welcome page's poll. Only status, business name and a masked email — nothing else. */
export async function getPublicPurchaseStatus(
  admin: AdminClient,
  sessionId: string,
): Promise<PublicPurchaseView | null> {
  const purchase = await findPurchaseBySession(admin, sessionId);
  if (!purchase) return null;
  return {
    status: publicStatusOf(purchase.status),
    businessName: purchase.business_name,
    emailMasked: maskEmail(purchase.owner_email),
  };
}

/** Checkout Session ids are `cs_test_…` / `cs_live_…`. */
export function isCheckoutSessionId(value: string): boolean {
  return /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(value);
}
