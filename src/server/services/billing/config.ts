/**
 * Billing plan + feature-gating configuration — the single source of truth for
 * what each plan includes. Pricing itself lives in Stripe (Products/Prices,
 * referenced via env in `billing/env.ts`); this module maps plans -> feature
 * access and NEVER encodes dollar amounts (mirrors the a1-pricing-engine
 * discipline: prices are data, not code).
 *
 * `internal` is the house-tenant plan (the A1 brands, boatnames, blairspm). Those
 * tenants are exempt from ALL billing enforcement, so the gating helper
 * (`billing/gating.ts`) short-circuits on `internal` and never consults this
 * table for them. The `internal` column below is therefore a documented
 * invariant — keep it all-true so any accidental consultation still allows.
 */

export const BILLING_PLANS = ["internal", "launch", "operate", "front_desk"] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

export const SUBSCRIPTION_STATUSES = [
  "none",
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Plans a customer can actually buy in Stripe (everything except the house plan). */
export type PurchasablePlan = Exclude<BillingPlan, "internal">;
export const PURCHASABLE_PLANS: readonly PurchasablePlan[] = ["launch", "operate", "front_desk"];

export const BILLING_FEATURES = [
  "lead_intake",
  "bookings",
  "tasks",
  "workflows",
  "sms_sequences",
  "marina_reception",
] as const;
export type BillingFeature = (typeof BILLING_FEATURES)[number];

/**
 * Per-plan boolean access. `marina_reception` is front_desk-only (per the phase
 * spec); `internal` is all-true by invariant. Tune freely — this table is the
 * only place plan/feature access is defined.
 */
export const PLAN_FEATURE_DEFAULTS: Record<BillingPlan, Record<BillingFeature, boolean>> = {
  internal:   { lead_intake: true, bookings: true, tasks: true, workflows: true,  sms_sequences: true,  marina_reception: true  },
  launch:     { lead_intake: true, bookings: true, tasks: true, workflows: false, sms_sequences: false, marina_reception: false },
  operate:    { lead_intake: true, bookings: true, tasks: true, workflows: true,  sms_sequences: true,  marina_reception: false },
  front_desk: { lead_intake: true, bookings: true, tasks: true, workflows: false, sms_sequences: false, marina_reception: true  },
};

/**
 * Optional numeric caps per plan+feature. Absent => unlimited (null). A
 * `feature_flags.limit_value` row overrides these at runtime (see `orgLimit`).
 * No caps are defined in Phase 1; the shape is here for Phase 2.
 */
export const PLAN_FEATURE_LIMITS: Record<BillingPlan, Partial<Record<BillingFeature, number>>> = {
  internal: {},
  launch: {},
  operate: {},
  front_desk: {},
};

export function isBillingPlan(value: string): value is BillingPlan {
  return (BILLING_PLANS as readonly string[]).includes(value);
}

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

export function isBillingFeature(value: string): value is BillingFeature {
  return (BILLING_FEATURES as readonly string[]).includes(value);
}

/** Plan default for a feature. Unknown plan/feature => false (deny by default). */
export function planDefault(plan: string, feature: string): boolean {
  if (!isBillingPlan(plan) || !isBillingFeature(feature)) {
    return false;
  }
  return PLAN_FEATURE_DEFAULTS[plan][feature];
}

/** Plan default numeric limit for a feature, or null for unlimited. */
export function planLimit(plan: string, feature: string): number | null {
  if (!isBillingPlan(plan) || !isBillingFeature(feature)) {
    return null;
  }
  return PLAN_FEATURE_LIMITS[plan][feature] ?? null;
}
