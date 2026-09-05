import { isBillingFeature, planDefault, planLimit, type BillingFeature } from "@/server/services/billing/config";
import { getPastDueGraceDays } from "@/server/services/billing/env";
import { AuthorizationError, UsageCapExceeded } from "@/server/organizations/context";
import { getUsageForFeature } from "@/server/services/usage";
import type { createSupabaseServerClient } from "@/server/supabase/server";

/**
 * Server-side feature gating. THIS IS THE ENFORCEMENT SURFACE — call it from API
 * routes / server code, never trust the client. Phase 1 only provides the helper;
 * wiring it into existing routes happens in Phase 2.
 *
 * Typed against the RLS server client (what routes hold). The service-role admin
 * client is structurally compatible; pass it with a cast if ever needed off the
 * request path.
 */
type BillingClient = ReturnType<typeof createSupabaseServerClient>;

interface OrgBillingState {
  plan: string;
  subscription_status: string;
  trial_ends_at: string | null;
}

interface OrgEvaluation {
  plan: string;
  internal: boolean;
  healthy: boolean;
}

async function loadOrgBillingState(
  supabase: BillingClient,
  organizationId: string,
): Promise<OrgBillingState | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("plan, subscription_status, trial_ends_at")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return (data as OrgBillingState | null) ?? null;
}

async function latestCurrentPeriodEnd(
  supabase: BillingClient,
  organizationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("current_period_end")
    .eq("organization_id", organizationId)
    .order("current_period_end", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  const row = data as { current_period_end: string | null } | null;
  return row?.current_period_end ?? null;
}

async function loadFeatureFlag(
  supabase: BillingClient,
  organizationId: string,
  feature: string,
): Promise<{ enabled: boolean; limit_value: number | null } | null> {
  const { data, error } = await supabase
    .from("feature_flags")
    .select("enabled, limit_value")
    .eq("organization_id", organizationId)
    .eq("feature", feature)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return (data as { enabled: boolean; limit_value: number | null } | null) ?? null;
}

/**
 * Is a non-internal subscription in good standing for paid access? `active` is
 * healthy; `trialing` is healthy until `trial_ends_at` (a trial with no end date
 * stays open-ended); `past_due` is healthy only until current_period_end + grace
 * elapses; none/canceled/unknown are not. Exported for direct unit testing.
 */
export function isBillingHealthy(
  status: string,
  currentPeriodEnd: string | null,
  trialEndsAt: string | null,
  now: Date,
  graceDays: number,
): boolean {
  switch (status) {
    case "active":
      return true;
    case "trialing":
      // A trial lapses at trial_ends_at; no date => open-ended trial (healthy).
      return trialEndsAt ? now.getTime() <= new Date(trialEndsAt).getTime() : true;
    case "past_due": {
      if (!currentPeriodEnd) {
        return false;
      }
      const cutoff = new Date(
        new Date(currentPeriodEnd).getTime() + graceDays * 24 * 60 * 60 * 1000,
      );
      return now.getTime() <= cutoff.getTime();
    }
    default:
      return false;
  }
}

async function evaluateOrg(
  supabase: BillingClient,
  organizationId: string,
): Promise<OrgEvaluation | null> {
  const org = await loadOrgBillingState(supabase, organizationId);
  if (!org) {
    return null;
  }
  if (org.plan === "internal") {
    return { healthy: true, internal: true, plan: org.plan };
  }

  const periodEnd = await latestCurrentPeriodEnd(supabase, organizationId);
  const healthy = isBillingHealthy(
    org.subscription_status,
    periodEnd,
    org.trial_ends_at,
    new Date(),
    getPastDueGraceDays(),
  );
  return { healthy, internal: false, plan: org.plan };
}

/**
 * Whether an org may use a feature. `internal` (house tenants) => always true.
 * Otherwise the subscription must be healthy AND (feature_flags override, if any,
 * else the plan default) must allow it. Unknown org / unknown feature => false.
 */
export async function orgCan(
  supabase: BillingClient,
  organizationId: string,
  feature: string,
): Promise<boolean> {
  const evaluation = await evaluateOrg(supabase, organizationId);
  if (!evaluation) {
    return false;
  }
  if (evaluation.internal) {
    return true;
  }
  if (!isBillingFeature(feature)) {
    return false;
  }
  if (!evaluation.healthy) {
    return false;
  }

  const flag = await loadFeatureFlag(supabase, organizationId, feature);
  if (flag) {
    return flag.enabled;
  }
  return planDefault(evaluation.plan, feature);
}

/**
 * The numeric limit for a feature, or null for unlimited. `internal` => null
 * (unlimited). Gated-off orgs (unhealthy) => 0. A feature_flags.limit_value
 * overrides the plan default.
 */
export async function orgLimit(
  supabase: BillingClient,
  organizationId: string,
  feature: string,
): Promise<number | null> {
  const evaluation = await evaluateOrg(supabase, organizationId);
  if (!evaluation) {
    return 0;
  }
  if (evaluation.internal) {
    return null;
  }
  if (!isBillingFeature(feature)) {
    return 0;
  }
  if (!evaluation.healthy) {
    return 0;
  }

  const flag = await loadFeatureFlag(supabase, organizationId, feature);
  if (flag && flag.limit_value !== null && flag.limit_value !== undefined) {
    return flag.limit_value;
  }
  return planLimit(evaluation.plan, feature);
}

/**
 * How much of a metered feature's monthly allowance is left, or null when the feature is
 * unlimited (internal tenants, or a feature with no cap). Negative is possible (overage).
 * Consults usage_monthly_v via the caller's RLS client (Task 6).
 */
export async function orgUsageRemaining(
  supabase: BillingClient,
  organizationId: string,
  feature: string,
): Promise<number | null> {
  const limit = await orgLimit(supabase, organizationId, feature);
  if (limit === null) {
    return null; // unlimited
  }
  const used = await getUsageForFeature(supabase, organizationId, feature);
  return limit - used;
}

/**
 * Route-level enforcement guard: throws AuthorizationError (→ 403 via handleRoute)
 * unless the org may use `feature`, then UsageCapExceeded (→ 402) if the month's metered
 * allowance is spent. Call it right after requireOrganizationContext. internal/house
 * tenants and features with no cap always pass the usage check (remaining === null).
 */
export async function requireFeature(
  supabase: BillingClient,
  organizationId: string,
  feature: BillingFeature,
): Promise<void> {
  const allowed = await orgCan(supabase, organizationId, feature);
  if (!allowed) {
    throw new AuthorizationError(`Your plan does not include this feature (${feature}).`);
  }

  const remaining = await orgUsageRemaining(supabase, organizationId, feature);
  if (remaining !== null && remaining <= 0) {
    throw new UsageCapExceeded(`This month's included allowance for ${feature} is used up.`);
  }
}
