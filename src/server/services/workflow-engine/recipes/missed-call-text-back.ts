import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/** A missed/voicemail/too-short call → instant text-back with a booking link. */
export const missedCallTextBack: Recipe = {
  slug: "missed-call-text-back",
  name: "Missed-call text-back",
  description:
    "When a call is missed or goes to voicemail, instantly text the caller a booking link so the lead isn't lost.",
  trigger_event: "call.missed",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 300,
    actions: [
      {
        type: "send_sms",
        to: "contact",
        body: "Hi {{contact.first_name}}, sorry we missed you — {{company.name}} here. Book here: {{company.booking_url}} or reply and we'll call you back.",
      },
    ],
  },
};
