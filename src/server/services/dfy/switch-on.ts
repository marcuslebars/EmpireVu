// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): done-for-you switch-on. Runs from the done-for-you
// sweep (worker scheduler, no session) for ONE company, with a context pinned to that
// company's own organization_id; every change goes through the normal tenant services
// (installRecipes, updateWorkflowStatus, updateReviewSettings, updateOnlineBookingSettings,
// provisionPhoneForCompany). docs/done-for-you.md → "Automatic switch-on".
// ─────────────────────────────────────────────────────────────────────────────
import type { Json, Tables } from "@/server/db/database.types";
import { CLOSE_EXTRA_RECIPE_SLUGS, dfyRecipeSlugs, type CrankleadsTier } from "@/server/services/crankleads/config";
import { restrictAutomationsToTier } from "@/server/services/crankleads/tier-automations";
import { bookingHoursFromCompanyHours } from "@/server/services/dfy/hours";
import { errorMessage } from "@/server/services/dfy/progress";
import { currentNumber } from "@/server/services/dfy/numbers";
import { getOnboardingProgress } from "@/server/services/onboarding";
import { provisionPhoneForCompany } from "@/server/services/onboarding-provision";
import type { RetellClient } from "@/server/services/retell/provision";
import { updateReviewSettings } from "@/server/services/reviews/service";
import { updateOnlineBookingSettings } from "@/server/services/scheduling/settings";
import type { TenantServiceContext } from "@/server/services/shared";
import { getRecipe } from "@/server/services/workflow-engine/recipes";
import { installRecipes, missingRequirements } from "@/server/services/workflow-engine/recipes/install";
import { updateWorkflowStatus } from "@/server/services/workflows";

export { CLOSE_EXTRA_RECIPE_SLUGS, dfyRecipeSlugs };

export interface AutomationsResult {
  activated: string[];
  alreadyActive: string[];
  keptDraft: Array<{ slug: string; reason: string }>;
  /** Catalog recipes outside the tier that were active and are now draft. */
  deactivated?: string[];
}

/**
 * Install any missing recipe of the tier, then turn its drafts on — unless a channel it needs
 * (SMS / email / voice) isn't configured on this deployment. Runs once per company (the
 * caller claims dfy_progress.switched_on_at), so an owner who later turns one off keeps it off.
 * Paused workflows are never touched.
 */
export async function switchOnAutomations(ctx: TenantServiceContext, companyId: string, tier: CrankleadsTier): Promise<AutomationsResult> {
  const slugs = dfyRecipeSlugs(tier);
  // Only the tier's automations may run: anything else the catalog installed active goes draft.
  const { deactivated } = await restrictAutomationsToTier(ctx, companyId, tier);
  await installRecipes(ctx, companyId, { only: slugs });
  const { data, error } = await ctx.supabase
    .from("workflows")
    .select("id, slug, status, definition")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", companyId)
    .in("slug", slugs);
  if (error) throw new Error(`workflow lookup failed: ${error.message}`);
  const result: AutomationsResult = { activated: [], alreadyActive: [], keptDraft: [], deactivated };
  for (const row of (data ?? []) as Array<Pick<Tables<"workflows">, "id" | "slug" | "status" | "definition">>) {
    if (row.status === "active") {
      result.alreadyActive.push(row.slug);
      continue;
    }
    if (row.status !== "draft") continue;
    const recipe = getRecipe(row.slug);
    const missing = recipe ? missingRequirements(recipe) : [];
    if (missing.length > 0) {
      result.keptDraft.push({ slug: row.slug, reason: `needs ${missing.join(" + ")}` });
      continue;
    }
    await updateWorkflowStatus(ctx, { workflowId: row.id, status: "active" });
    // Drop the install-time "needs SMS configured" note now that it can run.
    const definition = row.definition && typeof row.definition === "object" && !Array.isArray(row.definition) ? { ...(row.definition as Record<string, Json>) } : null;
    if (definition && "_disabled_reason" in definition) {
      delete definition._disabled_reason;
      await ctx.supabase.from("workflows").update({ definition }).eq("organization_id", ctx.organizationId).eq("id", row.id);
    }
    result.activated.push(row.slug);
  }
  return result;
}

type CompanyFacts = Pick<Tables<"companies">, "id" | "brand_review_url" | "review_settings" | "hours" | "online_booking_settings">;

export type ReviewsOutcome = "enabled" | "no_review_url" | "owner_set" | "failed";

/** Review requests on when there's a review link and the owner never chose (no `enabled` key). */
export async function switchOnReviews(ctx: TenantServiceContext, company: CompanyFacts): Promise<ReviewsOutcome> {
  if (!company.brand_review_url?.trim()) return "no_review_url";
  const settings = company.review_settings && typeof company.review_settings === "object" && !Array.isArray(company.review_settings) ? company.review_settings : {};
  if ("enabled" in (settings as Record<string, unknown>)) return "owner_set";
  try {
    await updateReviewSettings(ctx, company.id, { settings: { enabled: true } });
    return "enabled";
  } catch (err) {
    console.error(`[dfy/switch-on] review requests for ${company.id}: ${errorMessage(err)}`);
    return "failed";
  }
}

export type BookingOutcome = "hours_set" | "owner_set" | "no_hours" | "failed";

const BOOKING_HOUR_KEYS = ["startHour", "endHour", "workingDays"];

/** Booking hours from companies.hours, only while the booking hours are still the defaults. */
export async function applyBookingHours(ctx: TenantServiceContext, company: CompanyFacts): Promise<BookingOutcome> {
  const current =
    company.online_booking_settings && typeof company.online_booking_settings === "object" && !Array.isArray(company.online_booking_settings)
      ? (company.online_booking_settings as Record<string, unknown>)
      : {};
  if (BOOKING_HOUR_KEYS.some((key) => key in current)) return "owner_set";
  const hours = bookingHoursFromCompanyHours(company.hours);
  if (!hours) return "no_hours";
  try {
    await updateOnlineBookingSettings(ctx, company.id, hours);
    return "hours_set";
  } catch (err) {
    console.error(`[dfy/switch-on] booking hours for ${company.id}: ${errorMessage(err)}`);
    return "failed";
  }
}

export type ReceptionistOutcome = "rebuilt" | "not_front_desk" | "number_pending" | "failed";

/**
 * Front Desk: rebuild the AI receptionist's prompt from what we now know (hours, service area,
 * services with any prices) and re-push it to Retell — an UPDATE of the same LLM / agent /
 * number (ids from the Phone step), never a new purchase. Skipped until the number exists
 * (buying it builds the prompt from the same, current data).
 */
export async function rebuildReceptionist(
  ctx: TenantServiceContext,
  companyId: string,
  tier: CrankleadsTier,
  retell?: RetellClient,
): Promise<ReceptionistOutcome> {
  if (tier !== "front_desk") return "not_front_desk";
  try {
    if (!(await currentNumber(ctx, companyId, "ai"))) return "number_pending";
    const progress = await getOnboardingProgress(ctx, companyId);
    const data = progress.find((p) => p.step === "phone")?.data;
    const prior = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    if (!str(prior.llmId) || !str(prior.agentId) || !str(prior.phoneNumber)) return "number_pending";
    await provisionPhoneForCompany(
      ctx,
      { companyId, existing: { llmId: str(prior.llmId), agentId: str(prior.agentId), phoneNumber: str(prior.phoneNumber) } },
      retell,
    );
    return "rebuilt";
  } catch (err) {
    console.error(`[dfy/switch-on] receptionist rebuild for ${companyId}: ${errorMessage(err)}`);
    return "failed";
  }
}

export interface SwitchOnResult {
  automations: AutomationsResult | { error: string };
  reviews: ReviewsOutcome;
  booking: BookingOutcome;
  receptionist: ReceptionistOutcome;
}

/** Everything that can now work, each part best-effort (one failure never blocks the others). */
export async function switchOnEverything(
  ctx: TenantServiceContext,
  companyId: string,
  tier: CrankleadsTier,
  deps: { retell?: RetellClient } = {},
): Promise<SwitchOnResult> {
  const { data, error } = await ctx.supabase
    .from("companies")
    .select("id, brand_review_url, review_settings, hours, online_booking_settings")
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`company lookup failed: ${error.message}`);
  if (!data) throw new Error("company not found");
  const company = data as CompanyFacts;

  let automations: SwitchOnResult["automations"];
  try {
    automations = await switchOnAutomations(ctx, companyId, tier);
  } catch (err) {
    console.error(`[dfy/switch-on] automations for ${companyId}: ${errorMessage(err)}`);
    automations = { error: errorMessage(err).slice(0, 300) };
  }
  return {
    automations,
    reviews: await switchOnReviews(ctx, company),
    booking: await applyBookingHours(ctx, company),
    receptionist: await rebuildReceptionist(ctx, companyId, tier, deps.retell),
  };
}
