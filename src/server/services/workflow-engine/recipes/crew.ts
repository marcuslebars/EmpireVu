import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/**
 * Crew taps "On my way" on the job → text the customer a heads-up. Draft by default:
 * the brand turns it on once its crew is using My Jobs.
 */
export const crewOnTheWay: Recipe = {
  slug: "crew-on-the-way",
  name: "\"On my way\" text to the customer",
  description:
    "When your crew taps \"On my way\" on a job, text the customer a heads-up. Draft by default — turn it on once your crew uses My Jobs.",
  trigger_event: "booking.en_route",
  default_status: "draft",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 90,
    actions: [
      {
        type: "send_sms",
        to: "contact",
        body: "Hi {{contact.first_name}}, it's {{company.name}} — our crew is on the way for your {{booking.title}} now. See you soon!",
      },
    ],
  },
};
