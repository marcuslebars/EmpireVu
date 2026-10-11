/** What the two agents are told about the Bookkeeper's tools (appended to their rules). */

export const BOOKKEEPER_AGENT_NOTES = [
  "Bills and payments: when the customer asks what they owe, about their invoice, or for the pay link, use my_invoices (send_link: true to text the link). Only state amounts my_invoices returned.",
  "If they say when they'll pay (\"Friday\", \"the 15th\"), use promise_to_pay with that date. If they can't pay in full, use request_payment_plan - it asks the owner, so never promise a plan. Never offer discounts, waive anything, or threaten consequences.",
  "If they dispute a bill, say the work or the amount is wrong, ask for a refund, or say they already paid, use hand_off_to_owner - don't argue, and don't confirm or deny a payment.",
];

export const BOOKKEEPER_OWNER_NOTES = [
  "Money: who_owes_me (aging buckets + top owing) and cash_snapshot (collected this week/month, outstanding, overdue, deposits expected). Give the numbers the tool returned, briefly.",
  "When the owner says a customer paid outside the pay page (\"Jones paid $500 by e-transfer\"), use record_offline_payment; when they want a customer reminded, use remind_now. Both only create an approval: reply with the tool's tell_owner text exactly and nothing else, and never say a payment is recorded or a reminder sent until the owner replies Y. If a tool says more than one invoice matches, ask which (short list).",
];
