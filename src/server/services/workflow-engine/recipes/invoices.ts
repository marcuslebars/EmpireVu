import type { Recipe } from "@/server/services/workflow-engine/recipes/types";

/**
 * The invoicing pack: what happens around getting paid. Owner alerts read only
 * {{invoice.*}} so they work for business-account invoices too (no contact).
 */

/** 💰 An invoice is paid in full → text the owner. */
export const invoicePaidOwnerAlert: Recipe = {
  slug: "invoice-paid-owner-alert",
  name: "Text me when an invoice is paid",
  description: "Text you the moment an invoice is paid in full, with the number, amount and job.",
  trigger_event: "invoice.paid",
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
        body: "💰 {{invoice.number}} paid in full · {{invoice.total}} · {{invoice.title}}",
      },
    ],
  },
};

/**
 * Paid → thank the customer and ask for a review. Draft by default: brands already
 * running "Review request" (a day after the job is done) should pick ONE of the two,
 * or the customer gets asked twice.
 */
export const invoicePaidThankYou: Recipe = {
  slug: "invoice-paid-thank-you",
  name: "Thank-you + review ask when paid",
  description:
    "When an invoice is paid, text the customer a thank-you with your review link. Draft by default — use this OR \"Review request\", not both, so nobody is asked twice.",
  trigger_event: "invoice.paid",
  default_status: "draft",
  requires: ["sms"],
  definition: {
    version: 1,
    conditions: [],
    estimated_time_saved_seconds: 180,
    actions: [
      { type: "wait", duration: "2h" },
      {
        type: "send_sms",
        to: "contact",
        body:
          "Thanks for your payment, {{contact.first_name}} — {{company.name}} appreciates your business! " +
          "If you have a moment, a quick review helps a lot: {{company.review_url}}",
      },
    ],
  },
};

/** An invoice goes past due (fires once, the first day it's late) → tell the owner. */
export const invoiceOverdueOwnerAlert: Recipe = {
  slug: "invoice-overdue-owner-alert",
  name: "Tell me when an invoice is overdue",
  description:
    "Email you the first day an invoice is past due, with the balance and the pay link. Customer reminders are set in Settings → Invoices.",
  trigger_event: "invoice.overdue",
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
        subject: "{{invoice.number}} is overdue ({{invoice.balance}} owing)",
        body:
          "{{invoice.number}} — {{invoice.title}} — was due {{invoice.due}} and still has {{invoice.balance}} owing. " +
          "Pay link: {{invoice.public_url}}",
      },
    ],
  },
};
