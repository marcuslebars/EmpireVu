import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/** A caller flagged something urgent → alert the owner on both channels immediately. */
export const urgentCallEscalation: Recipe = {
  slug: "urgent-call-escalation",
  name: "Urgent-call escalation",
  description: "When a caller flags something urgent, alert the owner by SMS and email immediately.",
  trigger_event: "call.urgent",
  default_status: "active",
  requires: ["email"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 120,
    actions: [
      {
        type: "notify_owner",
        channel: "both",
        subject: "\u{1F6A8} Urgent call for {{company.name}}",
        body: "Urgent: {{contact.first_name}} {{contact.last_name}} ({{contact.phone}}) flagged an urgent need on a call. Call them back now.",
      },
    ],
  },
};
