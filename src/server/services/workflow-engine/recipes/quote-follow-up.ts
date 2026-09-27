import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/**
 * Quote sent → text nudge in 2 days, email nudge in 5, then a personal-touch task —
 * stopping early once the lead has converted or been lost, the deposit has been paid, or
 * a date has been booked.
 *
 * quote.* events anchor to the contact (Task 9). The contact's stage and — since the
 * receptionist work — the quote's own live state (quote_deposit_paid, quote_booked; see
 * workflow-engine/context.ts) are re-read when each wait resumes, so a customer who has
 * already paid is never nudged to pay. Nudges only go out 09:00–20:00 local.
 */
/** Keep nudging only while the lead is open and the customer hasn't paid or booked. */
const STILL_OPEN = [
  { field: "stage", operator: "in" as const, value: ["lead", "qualified"] },
  { field: "quote_deposit_paid", operator: "equals" as const, value: false },
  { field: "quote_booked", operator: "equals" as const, value: false },
];

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
        within_hours: { start: "09:00", end: "20:00" },
        resume_conditions: STILL_OPEN,
      },
      {
        type: "send_sms",
        to: "contact",
        body: "Hi {{contact.first_name}}, just checking you got your quote from {{company.name}} ({{quote.subtotal}} + HST). It's still good — approve it and hold your date here: {{quote.public_url}} Any questions? Just reply.",
      },
      {
        type: "wait",
        duration: "3d",
        within_hours: { start: "09:00", end: "20:00" },
        resume_conditions: STILL_OPEN,
      },
      {
        type: "send_email",
        to: "contact",
        subject: "Your {{company.name}} quote",
        body: "Hi {{contact.first_name}},\n\nFollowing up on the quote we sent — it's still available: {{quote.public_url}}\n\nReply to this email with any questions.\n\nThanks,\n{{company.name}}",
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
