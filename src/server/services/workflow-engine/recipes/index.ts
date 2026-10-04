import {
  invoiceOverdueOwnerAlert,
  invoicePaidOwnerAlert,
  invoicePaidThankYou,
} from "@/server/services/workflow-engine/recipes/invoices";
import { crewOnTheWay } from "@/server/services/workflow-engine/recipes/crew";
import { bookingReminder } from "@/server/services/workflow-engine/recipes/booking-reminder";
import { missedCallTextBack } from "@/server/services/workflow-engine/recipes/missed-call-text-back";
import { newLeadOwnerAlert } from "@/server/services/workflow-engine/recipes/new-lead-owner-alert";
import { noShowRecovery } from "@/server/services/workflow-engine/recipes/no-show-recovery";
import { quoteFollowUp } from "@/server/services/workflow-engine/recipes/quote-follow-up";
import { reviewRequest } from "@/server/services/workflow-engine/recipes/review-request";
import { staleLeadNudge } from "@/server/services/workflow-engine/recipes/stale-lead-nudge";
import { urgentCallEscalation } from "@/server/services/workflow-engine/recipes/urgent-call-escalation";
import {
  callAbandonedRecoveryText,
  callStartedToOwner,
  callSummaryToOwner,
  customerTextToOwner,
  depositLinkFailedOwnerAlert,
  depositPaidOwnerAlert,
  depositPaidPickDate,
  missedCallSummaryToOwner,
  postCallQuoteText,
} from "@/server/services/workflow-engine/recipes/marina";
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
  // The receptionist pack (Marina) — see recipes/marina.ts.
  callSummaryToOwner,
  missedCallSummaryToOwner,
  postCallQuoteText,
  depositPaidOwnerAlert,
  depositPaidPickDate,
  customerTextToOwner,
  callStartedToOwner,
  callAbandonedRecoveryText,
  depositLinkFailedOwnerAlert,
  // Getting paid — see recipes/invoices.ts.
  invoicePaidOwnerAlert,
  invoicePaidThankYou,
  invoiceOverdueOwnerAlert,
  // Crew dispatch — see recipes/crew.ts.
  crewOnTheWay,
];

const RECIPES_BY_SLUG = new Map(ALL_RECIPES.map((recipe) => [recipe.slug, recipe]));

export function getRecipe(slug: string): Recipe | null {
  return RECIPES_BY_SLUG.get(slug) ?? null;
}

export type { Recipe, RecipeRequirement } from "@/server/services/workflow-engine/recipes/types";
