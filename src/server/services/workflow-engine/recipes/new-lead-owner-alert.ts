import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/** A new lead arrives → alert the owner so no enquiry sits unseen. */
export const newLeadOwnerAlert: Recipe = {
  slug: "new-lead-owner-alert",
  name: "New-lead owner alert",
  description: "Ping the owner the moment a new lead arrives, so no enquiry sits unseen.",
  trigger_event: "contact.created",
  default_status: "active",
  requires: ["email"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 120,
    actions: [
      {
        type: "notify_owner",
        channel: "email",
        subject: "New lead for {{company.name}}",
        body: "New lead: {{contact.first_name}} {{contact.last_name}} — {{contact.phone}} / {{contact.email}}. Follow up while it's hot.",
      },
    ],
  },
};
