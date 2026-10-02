import type { PackRecipe } from "@/server/services/packs/types";

/**
 * Building blocks shared by the trade packs. Action indexes refer to the base recipe's
 * `definition.actions` (src/server/services/workflow-engine/recipes/*) and are checked by
 * src/test/industry-packs.test.ts — if a base recipe's actions are reordered, that test
 * fails before a pack can write a message into the wrong step.
 *
 * No prices here, ever (convention #4): money in a message is only ever a template
 * variable (`{{quote.subtotal}}`, `{{quote.deposit}}`) filled from the company's own quote.
 */

/** Owner-facing recipes every pack installs as-is (their texts go to the owner, not customers). */
export const OWNER_ALERT_RECIPES: PackRecipe[] = [
  { slug: "new-lead-owner-alert" },
  { slug: "urgent-call-escalation" },
  { slug: "call-summary-to-owner" },
  { slug: "missed-call-summary-to-owner" },
  { slug: "customer-text-to-owner" },
  { slug: "deposit-paid-owner-alert" },
];

/**
 * The receptionist's post-call quote text and the paid-but-no-date nudge, without the
 * marine wording (`{{quote.boat}}`) the base recipes carry from A1. Every non-marine pack
 * uses these so a roofer's customer never reads "your quote for the  is …".
 */
export function tradeQuoteRecipes(): PackRecipe[] {
  return [
    {
      slug: "post-call-quote-text",
      messages: [
        {
          actionIndex: 0,
          body:
            "Hi {{contact.first_name}}, {{company.name}} here. Thanks for calling! Your quote is {{quote.subtotal}} + HST. " +
            "Approve it and pay the {{quote.deposit}} deposit to hold your spot: {{quote.public_url}} Questions? Just reply here.",
        },
      ],
    },
    {
      slug: "deposit-paid-pick-date",
      messages: [
        {
          actionIndex: 1,
          body:
            "Hi {{contact.first_name}}, {{company.name}} here. Your {{quote.deposit}} deposit is in and your spot is held. " +
            "Pick the day that works for you: {{company.booking_url}} Questions? Just reply here.",
        },
      ],
    },
  ];
}

/** quote-follow-up: action 1 is the 2-day text, action 3 the 5-day email. */
export function quoteFollowUp(sms: string, emailBody: string): PackRecipe {
  return {
    slug: "quote-follow-up",
    messages: [
      { actionIndex: 1, body: sms },
      { actionIndex: 3, subject: "Your quote from {{company.name}}", body: emailBody },
    ],
  };
}

/** booking-reminder: action 0 is the day-before text, action 2 the ~2-hours-before text. */
export function bookingReminder(dayBefore: string, twoHoursBefore: string): PackRecipe {
  return {
    slug: "booking-reminder",
    messages: [
      { actionIndex: 0, body: dayBefore },
      { actionIndex: 2, body: twoHoursBefore },
    ],
  };
}

/** review-request: action 1 is the text (action 0, the wait, comes from pack.reviewRequest.delay). */
export function reviewRequest(body: string): PackRecipe {
  return { slug: "review-request", messages: [{ actionIndex: 1, body }] };
}

/** missed-call-text-back / no-show-recovery: action 0 is the only text. */
export function singleText(slug: "missed-call-text-back" | "no-show-recovery", body: string): PackRecipe {
  return { slug, messages: [{ actionIndex: 0, body }] };
}

export function staleLeadNudge(staleDays: number): PackRecipe {
  return { slug: "stale-lead-nudge", schedule: { stale_days: staleDays } };
}
