// ─────────────────────────────────────────────────────────────────────────────
// CrankLeads: a company only runs its tier's automations.
// Called with a context pinned to ONE organization (provisioning, done-for-you switch-on, the
// one-off repair job); every read/write is filtered by organization_id + company_id.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * createCompany installs the whole recipe catalog at each recipe's default status, so a Catch
 * buyer would otherwise get Close / Front Desk automations running (stale-lead-nudge texting
 * their leads, quote follow-ups…). After provisioning (and at switch-on) every catalog recipe
 * that is NOT in tierAllowedRecipeSlugs(tier, pack recipes) is set to draft. Custom workflows
 * (slugs not in the recipe catalog) are never touched; allowed ones are never turned on here.
 */
import type { Tables } from "@/server/db/database.types";
import { tierAllowedRecipeSlugs, type CrankleadsTier } from "@/server/services/crankleads/config";
import { getPack } from "@/server/services/packs";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";
import type { TenantServiceContext } from "@/server/services/shared";
import { ALL_RECIPES } from "@/server/services/workflow-engine/recipes";

const CATALOG_SLUGS = new Set(ALL_RECIPES.map((r) => r.slug));

/** The company's applied pack's recipe slugs ([] when none). */
export async function packRecipeSlugsFor(ctx: TenantServiceContext, companyId: string): Promise<string[]> {
  const { data, error } = await ctx.supabase
    .from("companies")
    .select("industry_pack")
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`company lookup failed: ${error.message}`);
  const applied = parseAppliedIndustryPack((data as { industry_pack: unknown } | null)?.industry_pack ?? null);
  const pack = applied ? getPack(applied.id) : null;
  return pack ? pack.recipes.map((r) => r.slug) : [];
}

/** PURE: which active catalog workflows must go to draft for this tier. */
export function workflowsOutsideTier(
  workflows: Array<Pick<Tables<"workflows">, "id" | "slug" | "status">>,
  allowed: Set<string>,
): Array<{ id: string; slug: string }> {
  return workflows
    .filter((w) => w.status === "active" && w.slug && CATALOG_SLUGS.has(w.slug) && !allowed.has(w.slug))
    .map((w) => ({ id: w.id, slug: w.slug as string }));
}

export interface RestrictResult {
  deactivated: string[];
}

/**
 * Set every active catalog recipe outside the tier to draft. `dryRun` reports without writing.
 * Idempotent.
 */
export async function restrictAutomationsToTier(
  ctx: TenantServiceContext,
  companyId: string,
  tier: CrankleadsTier,
  options: { dryRun?: boolean; packRecipeSlugs?: string[] } = {},
): Promise<RestrictResult> {
  const packSlugs = options.packRecipeSlugs ?? (await packRecipeSlugsFor(ctx, companyId));
  const allowed = tierAllowedRecipeSlugs(tier, packSlugs);
  const { data, error } = await ctx.supabase
    .from("workflows")
    .select("id, slug, status")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", companyId)
    .eq("status", "active");
  if (error) throw new Error(`workflow lookup failed: ${error.message}`);
  const outside = workflowsOutsideTier((data ?? []) as Array<Pick<Tables<"workflows">, "id" | "slug" | "status">>, allowed);
  if (!options.dryRun) {
    for (const w of outside) {
      const { error: updateError } = await ctx.supabase
        .from("workflows")
        .update({ status: "draft" })
        .eq("organization_id", ctx.organizationId)
        .eq("company_id", companyId)
        .eq("id", w.id)
        .eq("status", "active");
      if (updateError) throw new Error(`workflow ${w.slug} update failed: ${updateError.message}`);
    }
  }
  return { deactivated: outside.map((w) => w.slug) };
}
