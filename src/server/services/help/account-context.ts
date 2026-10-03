import { ONBOARDING_STEPS, getOnboardingProgress } from "@/server/services/onboarding";
import { listCompanies } from "@/server/services/companies";
import type { TenantServiceContext } from "@/server/services/shared";

/**
 * The light, non-sensitive account facts the Help assistant may use to tailor an answer and
 * that the operator email carries: plan / status / CrankLeads tier and setup progress.
 *
 * Read on the CALLER's RLS client and filtered by the org id that requireOrganizationContext
 * already proved they belong to — so it can only ever describe their own org. No contacts,
 * messages, money or ids go in here.
 */
export interface HelpAccountContext {
  organizationName: string | null;
  plan: string | null;
  subscriptionStatus: string | null;
  crankleadsTier: string | null;
  role: string | null;
  companyName: string | null;
  setup: { done: string[]; remaining: string[] } | null;
}

export const PLAN_LABELS: Record<string, string> = {
  internal: "Internal (house account)",
  launch: "Launch",
  operate: "Operate",
  front_desk: "Front Desk",
};

export const TIER_LABELS: Record<string, string> = {
  catch: "CrankLeads Catch",
  close: "CrankLeads Close",
  front_desk: "CrankLeads Front Desk",
};

export const STEP_LABELS: Record<string, string> = {
  business: "Business",
  services: "Services",
  phone: "Phone",
  payments: "Payments",
  website: "Website leads",
  test_call: "Test call",
  team: "Team",
  recipes: "Automations",
};

export const EMPTY_ACCOUNT_CONTEXT: HelpAccountContext = {
  organizationName: null,
  plan: null,
  subscriptionStatus: null,
  crankleadsTier: null,
  role: null,
  companyName: null,
  setup: null,
};

/** Best-effort: any read failure degrades to less context, never to a failed answer. */
export async function loadHelpAccountContext(
  context: TenantServiceContext,
  role: string | null,
): Promise<HelpAccountContext> {
  const result: HelpAccountContext = { ...EMPTY_ACCOUNT_CONTEXT, role };

  try {
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("name, plan, subscription_status, crankleads_tier")
      .eq("id", context.organizationId)
      .maybeSingle();
    if (error) throw error;
    if (org) {
      result.organizationName = org.name;
      result.plan = org.plan;
      result.subscriptionStatus = org.subscription_status;
      result.crankleadsTier = org.crankleads_tier;
    }
  } catch (err) {
    console.warn("[help] account context: organization read failed:", err instanceof Error ? err.message : err);
  }

  try {
    // Same company the setup wizard resumes on (listCompanies limit 1).
    const companies = await listCompanies(context, { limit: 1 });
    const company = companies[0] ?? null;
    if (company) {
      result.companyName = company.name;
      const steps = await getOnboardingProgress(context, company.id);
      const done = new Set(steps.filter((s) => s.status === "complete").map((s) => s.step));
      result.setup = {
        done: ONBOARDING_STEPS.filter((s) => done.has(s)).map((s) => STEP_LABELS[s] ?? s),
        remaining: ONBOARDING_STEPS.filter((s) => !done.has(s)).map((s) => STEP_LABELS[s] ?? s),
      };
    }
  } catch (err) {
    console.warn("[help] account context: setup progress read failed:", err instanceof Error ? err.message : err);
  }

  return result;
}

/** Plain-text lines describing the account, shared by the prompt and the operator email. */
export function describeAccount(account: HelpAccountContext): string[] {
  const lines: string[] = [];
  if (account.plan) {
    lines.push(`Plan: ${PLAN_LABELS[account.plan] ?? account.plan}`);
  }
  if (account.crankleadsTier) {
    lines.push(`Bought through: ${TIER_LABELS[account.crankleadsTier] ?? account.crankleadsTier}`);
  }
  if (account.subscriptionStatus) lines.push(`Subscription status: ${account.subscriptionStatus}`);
  if (account.role) lines.push(`Their role: ${account.role}`);
  if (account.setup) {
    lines.push(`Setup steps done: ${account.setup.done.length ? account.setup.done.join(", ") : "none yet"}`);
    lines.push(`Setup steps remaining: ${account.setup.remaining.length ? account.setup.remaining.join(", ") : "none — setup is finished"}`);
  }
  return lines;
}
