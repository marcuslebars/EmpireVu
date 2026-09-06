import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/** Booking marked no-show → text the customer to rebook and flag it for the owner. */
export const noShowRecovery: Recipe = {
  slug: "no-show-recovery",
  name: "No-show recovery",
  description: "When a booking is marked no-show, text the customer to rebook and flag it for the owner.",
  trigger_event: "booking.no_show",
  default_status: "draft",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 300,
    actions: [
      {
        type: "send_sms",
        to: "contact",
        body: "Hi {{contact.first_name}}, we missed you for your {{company.name}} booking. No worries — rebook any time here: {{company.booking_url}}.",
      },
      {
        type: "create_task",
        title: "Rebook {{contact.first_name}} after no-show",
        priority: "high",
        due_in_days: 1,
      },
    ],
  },
};
