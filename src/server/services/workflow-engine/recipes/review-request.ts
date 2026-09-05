import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/**
 * A day after a completed job → text the customer a review link. Draft by default: it
 * needs the company's review URL ({{company.review_url}} ← companies.brand_review_url) set
 * before it should text real customers.
 */
export const reviewRequest: Recipe = {
  slug: "review-request",
  name: "Review request",
  description:
    "A day after a completed job, text the customer a link to leave a review. Draft by default — set your review link and turn it on.",
  trigger_event: "booking.completed",
  default_status: "draft",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 240,
    actions: [
      { type: "wait", duration: "1d" },
      {
        type: "send_sms",
        to: "contact",
        body: "Thanks for choosing {{company.name}}, {{contact.first_name}}! If you have a moment, we'd love a review: {{company.review_url}}",
      },
    ],
  },
};
