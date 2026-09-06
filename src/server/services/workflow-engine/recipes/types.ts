import type {
  SupportedWorkflowTriggerEventType,
  WorkflowDefinition,
} from "@/server/services/workflow-engine/types";

/**
 * Proven, ready-to-run automations every new company gets on day one (Task 10).
 *
 * A recipe is a typed WorkflowDefinition plus install metadata. `requires` lists the
 * outbound channels the recipe needs configured (SMS/email/voice); installRecipes drafts
 * a recipe whose channel isn't configured and stamps a disabled_reason, so nothing tries
 * to text or email from an unconfigured deployment.
 */
export type RecipeRequirement = "sms" | "email" | "voice";

export interface Recipe {
  slug: string;
  name: string;
  description: string;
  trigger_event: SupportedWorkflowTriggerEventType;
  default_status: "active" | "draft";
  requires: RecipeRequirement[];
  definition: WorkflowDefinition;
}
