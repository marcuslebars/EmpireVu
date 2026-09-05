import { bookingReminder } from "@/server/services/workflow-engine/recipes/booking-reminder";
import { missedCallTextBack } from "@/server/services/workflow-engine/recipes/missed-call-text-back";
import { newLeadOwnerAlert } from "@/server/services/workflow-engine/recipes/new-lead-owner-alert";
import { noShowRecovery } from "@/server/services/workflow-engine/recipes/no-show-recovery";
import { quoteFollowUp } from "@/server/services/workflow-engine/recipes/quote-follow-up";
import { reviewRequest } from "@/server/services/workflow-engine/recipes/review-request";
import { staleLeadNudge } from "@/server/services/workflow-engine/recipes/stale-lead-nudge";
import { urgentCallEscalation } from "@/server/services/workflow-engine/recipes/urgent-call-escalation";
import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/** The recipe catalog. Order = display order in the Automations → Recipes section. */
export const ALL_RECIPES: readonly Recipe[] = [
  missedCallTextBack,
  newLeadOwnerAlert,
  quoteFollowUp,
  bookingReminder,
  staleLeadNudge,
  reviewRequest,
  noShowRecovery,
  urgentCallEscalation,
];

const RECIPES_BY_SLUG = new Map(ALL_RECIPES.map((recipe) => [recipe.slug, recipe]));

export function getRecipe(slug: string): Recipe | null {
  return RECIPES_BY_SLUG.get(slug) ?? null;
}

export type { Recipe, RecipeRequirement } from "@/server/services/workflow-engine/recipes/types";
