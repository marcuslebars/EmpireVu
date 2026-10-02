import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/**
 * The receptionist pack — what the A1 Marine Care site did around Marina's calls, rebuilt
 * as ordinary, editable automations so every company with a Marina number gets them.
 *
 * Replaces (a1marinecare/src/lib/retell/*): the per-call owner text (webhook.ts), the
 * post-call quote text, the paid-but-no-date text and the 💰 deposit text (followups.ts /
 * the Stripe webhook), and the customer-reply relay (inbound-sms.ts). The quote nudge and
 * the day-before reminder already exist as `quote-follow-up` and `booking-reminder`.
 *
 * Customer texts only go out 09:00–20:00 in the company's zone (wait.within_hours).
 */

const CIVIL_HOURS = { start: "09:00", end: "20:00" } as const;

/** Every answered call → the owner gets "what Marina just did" by text. */
export const callSummaryToOwner: Recipe = {
  slug: "call-summary-to-owner",
  name: "Text me after every call",
  description:
    "After each call your receptionist handles, text you who called, what they wanted, what was quoted or booked, and whether you need to call back.",
  trigger_event: "call.completed",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [{ field: "call_id", operator: "exists" }],
    estimated_time_saved_seconds: 120,
    actions: [{ type: "notify_owner", channel: "sms", body: "{{call.owner_summary}}" }],
  },
};

/** Missed / voicemail / hang-ups get the same text, so nothing slips by. */
export const missedCallSummaryToOwner: Recipe = {
  slug: "missed-call-summary-to-owner",
  name: "Text me about missed calls",
  description: "When a call is missed, goes to voicemail or hangs up early, text you the number and whatever was said.",
  trigger_event: "call.missed",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [{ field: "call_id", operator: "exists" }],
    estimated_time_saved_seconds: 60,
    actions: [{ type: "notify_owner", channel: "sms", body: "{{call.owner_summary}}" }],
  },
};

/**
 * Quoted on the phone but the link never went out (they said "let me think about it") →
 * text the quote while it's fresh. Skipped once the link was sent or the deposit paid.
 */
export const postCallQuoteText: Recipe = {
  slug: "post-call-quote-text",
  name: "Text the quote after a call",
  description:
    "When your receptionist quotes a caller who hangs up without the deposit link, text them the quote right away so they have it in hand.",
  trigger_event: "call.completed",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [
      { field: "quote_id", operator: "exists" },
      { field: "quote_deposit_paid", operator: "equals", value: false },
      { field: "quote_link_sent", operator: "equals", value: false },
    ],
    estimated_time_saved_seconds: 180,
    actions: [
      {
        type: "send_sms",
        to: "contact",
        body:
          "Hi {{contact.first_name}}, {{company.name}} here — thanks for calling! Your quote for the {{quote.boat}} is " +
          "{{quote.subtotal}} + HST. Approve it and pay the {{quote.deposit}} deposit to hold your date: {{quote.public_url}} " +
          "Questions? Just reply here.",
      },
    ],
  },
};

/** 💰 The moment a deposit lands. */
export const depositPaidOwnerAlert: Recipe = {
  slug: "deposit-paid-owner-alert",
  name: "Text me when a deposit is paid",
  description: "Text you the moment a customer pays a deposit, with who, what and how much.",
  trigger_event: "quote.deposit_paid",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 60,
    actions: [
      {
        type: "notify_owner",
        channel: "sms",
        body:
          "💰 {{contact.first_name}} {{contact.last_name}} paid the {{quote.deposit}} deposit · {{quote.boat}} · " +
          "quoted {{quote.subtotal}} ({{quote.number}})",
      },
    ],
  },
};

/** Paid the deposit but never picked a date → one nudge a few hours later. */
export const depositPaidPickDate: Recipe = {
  slug: "deposit-paid-pick-date",
  name: "Remind paid customers to pick a date",
  description:
    "If a customer pays the deposit but hasn't booked a date 4 hours later, text them the booking link (during the day only).",
  trigger_event: "quote.deposit_paid",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [{ field: "quote_booked", operator: "equals", value: false }],
    estimated_time_saved_seconds: 300,
    actions: [
      {
        type: "wait",
        duration: "4h",
        within_hours: CIVIL_HOURS,
        resume_conditions: [{ field: "quote_booked", operator: "equals", value: false }],
      },
      {
        type: "send_sms",
        to: "contact",
        body:
          "Hi {{contact.first_name}}, {{company.name}} here — your {{quote.deposit}} deposit is in and your spot for the " +
          "{{quote.boat}} is held. Pick the day that works for you: {{company.booking_url}} Questions? Just reply here.",
      },
    ],
  },
};

/** A customer texts back → relay it to the owner with who it is. */
export const customerTextToOwner: Recipe = {
  slug: "customer-text-to-owner",
  name: "Forward customer texts to me",
  description: "When a customer replies to one of your texts, forward it to your phone with their name.",
  trigger_event: "contact.sms_received",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 60,
    actions: [
      {
        type: "notify_owner",
        channel: "sms",
        body: '💬 Text from {{contact.first_name}} {{contact.last_name}} ({{message_from}}): "{{message_preview}}" — reply to them at {{message_from}}',
      },
    ],
  },
};

/** 📞 The receptionist just picked up — a heads-up while the call is live. */
export const callStartedToOwner: Recipe = {
  slug: "call-started-to-owner",
  name: "Text me when a call comes in",
  description: "The moment your receptionist answers a call, text you the caller's number so you can listen in or expect a follow-up.",
  trigger_event: "call.started",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [{ field: "call_from", operator: "exists" }],
    estimated_time_saved_seconds: 10,
    actions: [{ type: "notify_owner", channel: "sms", body: "📞 Answering a call from {{call_from}} ({{call_time}})." }],
  },
};

/**
 * Asked about the service, then hung up before a quote → one recovery text. Not for
 * returning customers, and at most once a week per number (see call.abandoned).
 */
export const callAbandonedRecoveryText: Recipe = {
  slug: "call-abandoned-recovery-text",
  name: "Text callers who hang up before a quote",
  description:
    "When someone asks about your service but the call ends before they get a quote, text them once so they can finish online or call back.",
  trigger_event: "call.abandoned",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 180,
    actions: [
      {
        type: "send_sms",
        to: "contact",
        body:
          "Hi, it's {{company.name}} — sorry we didn't get all the way through just now. Book or get a price here: " +
          "{{company.booking_url}} — or reply and we'll call you back.",
      },
    ],
  },
};

/** ⚠️ The caller was promised the deposit link but it didn't go out. */
export const depositLinkFailedOwnerAlert: Recipe = {
  slug: "deposit-link-failed-owner-alert",
  name: "Text me if a deposit link fails",
  description:
    "If your receptionist can't send a caller their deposit link, text you who it was so you can send it yourself — they were told you would.",
  trigger_event: "quote.deposit_link_failed",
  default_status: "active",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 120,
    actions: [
      {
        type: "notify_owner",
        channel: "sms",
        body:
          "⚠️ Couldn't send the deposit link to {{contact.first_name}} {{contact.last_name}} ({{contact.phone}}) — " +
          "{{failure_reason}}. They were told you'd text it within the hour: {{quote.public_url}} (quote {{quote_short_id}})",
      },
    ],
  },
};

export { CIVIL_HOURS };
