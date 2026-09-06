import { isEmailSendConfigured } from "@/server/outbound/email";
import { isSmsSendConfigured } from "@/server/outbound/sms";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { isVoiceConfigured } from "@/server/services/voice";
import { ALL_RECIPES } from "@/server/services/workflow-engine/recipes";
import type { Recipe, RecipeRequirement } from "@/server/services/workflow-engine/recipes/types";
import { createWorkflow } from "@/server/services/workflows";

/**
 * Install proven recipes onto a company (Task 10). Idempotent by workflows.slug — a recipe
 * already present for the company is skipped, so this is safe to call from createCompany and
 * again from the manual install route. A recipe whose required channel (SMS/email/voice)
 * isn't configured installs as a draft with a disabled_reason instead of silently trying to
 * send from an unconfigured deployment.
 */

export interface InstalledRecipe {
  slug: string;
  workflowId: string;
  status: "active" | "draft";
  disabledReason: string | null;
}

export interface InstallRecipesResult {
  installed: InstalledRecipe[];
  skipped: Array<{ slug: string; reason: "already_installed" }>;
}

export interface InstallRecipesOptions {
  /** Restrict to these recipe slugs; omit to install the whole catalog. */
  only?: string[];
  /** Seed customer-facing recipes as draft (used when seeding real tenants). */
  forceDraftCustomerFacing?: boolean;
}

function providerConfigured(requirement: RecipeRequirement): boolean {
  switch (requirement) {
    case "sms":
      return isSmsSendConfigured();
    case "email":
      return isEmailSendConfigured();
    case "voice":
      return isVoiceConfigured();
    default:
      return false;
  }
}

export function missingRequirements(recipe: Recipe): RecipeRequirement[] {
  return recipe.requires.filter((requirement) => !providerConfigured(requirement));
}

/** Does this recipe send SMS/email to the customer (vs. only owner alerts / tasks)? */
export function recipeTextsCustomers(recipe: Recipe): boolean {
  return recipe.definition.actions.some(
    (action) => (action.type === "send_sms" || action.type === "send_email") && action.to !== "owner",
  );
}

/** slug → workflow id for the recipes already installed on this company. */
async function existingRecipeWorkflows(
  context: TenantServiceContext,
  companyId: string | null,
): Promise<Map<string, string>> {
  let query = context.supabase
    .from("workflows")
    .select("id, slug")
    .eq("organization_id", context.organizationId);
  query = companyId ? query.eq("company_id", companyId) : query.is("company_id", null);
  const { data, error } = await query;
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.slug, row.id]));
}

export async function installRecipes(
  context: TenantServiceContext,
  companyId: string,
  options: InstallRecipesOptions = {},
): Promise<InstallRecipesResult> {
  await assertCompanyInOrganization(context, companyId);

  const only = options.only ? new Set(options.only) : null;
  const recipes = ALL_RECIPES.filter((recipe) => !only || only.has(recipe.slug));
  const alreadyInstalled = await existingRecipeWorkflows(context, companyId);

  const result: InstallRecipesResult = { installed: [], skipped: [] };

  for (const recipe of recipes) {
    if (alreadyInstalled.has(recipe.slug)) {
      result.skipped.push({ slug: recipe.slug, reason: "already_installed" });
      continue;
    }

    const missing = missingRequirements(recipe);
    let status: "active" | "draft" = recipe.default_status;
    let disabledReason: string | null = null;

    if (missing.length > 0) {
      status = "draft";
      disabledReason = `Needs ${missing.join(" + ")} configured before it can run.`;
    } else if (options.forceDraftCustomerFacing && recipeTextsCustomers(recipe)) {
      status = "draft";
      disabledReason = "Seeded as draft — review the messages, then turn it on.";
    }

    const definition = {
      ...recipe.definition,
      ...(disabledReason ? { _disabled_reason: disabledReason } : {}),
    } as Record<string, unknown>;

    const workflow = await createWorkflow(context, {
      companyId,
      name: recipe.name,
      slug: recipe.slug,
      description: recipe.description,
      triggerEvent: recipe.trigger_event,
      definition,
      status,
    });

    result.installed.push({ slug: recipe.slug, workflowId: workflow.id, status, disabledReason });
  }

  return result;
}

export interface RecipeCatalogEntry {
  slug: string;
  name: string;
  description: string;
  triggerEvent: string;
  defaultStatus: "active" | "draft";
  requires: RecipeRequirement[];
  estimatedTimeSavedSeconds: number;
  textsCustomers: boolean;
  missingRequirements: RecipeRequirement[];
  installed: boolean;
  installedWorkflowId: string | null;
}

/** The recipe catalog annotated for a given company: what's installed, what's blocked. */
export async function listRecipeCatalog(
  context: TenantServiceContext,
  companyId: string | null,
): Promise<RecipeCatalogEntry[]> {
  const installed = companyId ? await existingRecipeWorkflows(context, companyId) : new Map<string, string>();
  return ALL_RECIPES.map((recipe) => ({
    slug: recipe.slug,
    name: recipe.name,
    description: recipe.description,
    triggerEvent: recipe.trigger_event,
    defaultStatus: recipe.default_status,
    requires: recipe.requires,
    estimatedTimeSavedSeconds: recipe.definition.estimated_time_saved_seconds ?? 0,
    textsCustomers: recipeTextsCustomers(recipe),
    missingRequirements: missingRequirements(recipe),
    installed: installed.has(recipe.slug),
    installedWorkflowId: installed.get(recipe.slug) ?? null,
  }));
}
