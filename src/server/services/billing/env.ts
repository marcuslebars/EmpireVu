/**
 * Server-only billing environment access. Mirrors `src/server/supabase/env.ts`.
 *
 * SECRETS DISCIPLINE: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are
 * server-only. They must NEVER be exposed with a `VITE_`/`NEXT_PUBLIC_` prefix,
 * imported into the client bundle, or logged. Only the publishable key is
 * client-safe — and it is not consumed anywhere in Phase 1 (no UI), so it is not
 * read here; it lives in `.env.example`/docs for Phase 2.
 */

import type { PurchasablePlan } from "@/server/services/billing/config";

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/** Server-only. The Stripe secret API key (sk_... / rk_...). Never client-exposed. */
export function getStripeSecretKey(): string {
  return getRequiredEnv("STRIPE_SECRET_KEY");
}

/** Server-only. The webhook endpoint signing secret (whsec_...). Never client-exposed. */
export function getStripeWebhookSecret(): string {
  return getRequiredEnv("STRIPE_WEBHOOK_SECRET");
}

const PLAN_PRICE_ENV: Record<PurchasablePlan, string> = {
  launch: "STRIPE_PRICE_LAUNCH",
  operate: "STRIPE_PRICE_OPERATE",
  front_desk: "STRIPE_PRICE_FRONT_DESK",
};

/**
 * Resolve the Stripe recurring Price id for a purchasable plan. Prices are the
 * source of truth in Stripe; the app only references their ids via env — no
 * dollar amounts in code. `internal` is not purchasable and has no price.
 */
export function getStripePriceId(plan: PurchasablePlan): string {
  return getRequiredEnv(PLAN_PRICE_ENV[plan]);
}

/**
 * Optional one-time setup-fee Price id for a plan. Returns null when unset, so
 * checkout simply omits the setup line item. Env: STRIPE_SETUP_FEE_LAUNCH etc.
 */
export function getStripeSetupFeePriceId(plan: PurchasablePlan): string | null {
  return process.env[`STRIPE_SETUP_FEE_${plan.toUpperCase()}`] ?? null;
}

/**
 * Grace window (in days) after a past_due subscription's period end before paid
 * features gate off. Configurable via BILLING_PAST_DUE_GRACE_DAYS; default 7.
 */
export function getPastDueGraceDays(): number {
  const raw = process.env.BILLING_PAST_DUE_GRACE_DAYS;
  if (!raw) {
    return 7;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
}

/** Public base URL used to build Checkout/Portal return URLs. Shared with the app. */
export function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL ?? "http://localhost:3000";
}
