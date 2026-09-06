import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/** A lead goes quiet for 3 days → put a follow-up task on the owner's list. */
export const staleLeadNudge: Recipe = {
  slug: "stale-lead-nudge",
  name: "Stale-lead nudge",
  description: "When a lead has gone quiet for 3 days, put a follow-up task on the owner's list.",
  trigger_event: "contact.stale",
  default_status: "active",
  requires: [],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 180,
    schedule: { stale_days: 3 },
    actions: [
      {
        type: "create_task",
        title: "Follow up with {{contact.first_name}} — no activity in 3 days",
        priority: "medium",
        due_in_days: 1,
      },
    ],
  },
};
