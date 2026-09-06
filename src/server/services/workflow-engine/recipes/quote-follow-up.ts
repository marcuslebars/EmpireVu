import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/**
 * Quote sent → text nudge in 2 days, email nudge in 5, then a personal-touch task —
 * stopping early once the lead has converted or been lost.
 *
 * quote.* events anchor to the contact (Task 9, since "quote" isn't a trace entity), so the
 * live signal available when a wait resumes is the contact's stage, not the quote's
 * viewed/approved state. The sequence therefore continues only while the contact is still an
 * open lead (lead/qualified) and stops once they move to active/closed.
 */
export const quoteFollowUp: Recipe = {
  slug: "quote-follow-up",
  name: "Quote follow-up sequence",
  description:
    "After a quote is sent, nudge by text in 2 days and by email in 5, then flag it for the owner — unless the lead has already converted.",
  trigger_event: "quote.sent",
  default_status: "active",
  requires: ["sms", "email"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 600,
    actions: [
      {
        type: "wait",
        duration: "2d",
        resume_conditions: [{ field: "stage", operator: "in", value: ["lead", "qualified"] }],
      },
      {
        type: "send_sms",
        to: "contact",
        body: "Hi {{contact.first_name}}, just checking you got your quote from {{company.name}}. Any questions? Reply here or book: {{company.booking_url}}.",
      },
      {
        type: "wait",
        duration: "3d",
        resume_conditions: [{ field: "stage", operator: "in", value: ["lead", "qualified"] }],
      },
      {
        type: "send_email",
        to: "contact",
        subject: "Your {{company.name}} quote",
        body: "Hi {{contact.first_name}},\n\nFollowing up on the quote we sent — it's still available. Reply to this email with any questions, or book a time here: {{company.booking_url}}.\n\nThanks,\n{{company.name}}",
      },
      {
        type: "create_task",
        title: "Personally follow up on {{contact.first_name}}'s quote",
        priority: "medium",
        due_in_days: 1,
      },
    ],
  },
};
