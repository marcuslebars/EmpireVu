/**
 * Every customer-facing Bookkeeper text, built in code (never by a model) so the owner approves
 * exactly what goes out. Short, plain, contractor voice, the business's own name, Canadian
 * spelling. Escalates gentle → firm, never beyond "final reminder": no legal threats, no
 * collections agencies, no late fees, no credit bureaus. PURE.
 */
import { dayDate, listJoin, money, plainText, shortDate } from "./format";
import type { Instalment } from "./db-types";

export type ReminderTone = "gentle" | "nudge" | "firm" | "last";

/** Tone for scheduled step `index` of `total`: first gentle, last firm + plan offer. PURE. */
export function toneForStep(index: number, total: number): ReminderTone {
  if (total <= 1) return "gentle";
  if (index <= 0) return "gentle";
  if (index >= total - 1) return "last";
  return index / (total - 1) < 0.5 ? "nudge" : "firm";
}

/** Tone for an ad-hoc reminder by how late it is. PURE. */
export function toneForDays(daysOverdue: number): ReminderTone {
  if (daysOverdue <= 7) return "gentle";
  if (daysOverdue <= 14) return "nudge";
  if (daysOverdue <= 29) return "firm";
  return "last";
}

export interface ReminderInput {
  businessName: string;
  firstName: string | null;
  invoiceNumber: string | null;
  owingCents: number;
  dueDate: string | null;
  daysOverdue: number;
  link: string;
}

function hi(firstName: string | null): string {
  return firstName ? `Hi ${firstName}` : "Hi";
}

function inv(n: string | null): string {
  return n ? `invoice ${n}` : "your invoice";
}

function Inv(n: string | null): string {
  return n ? `Invoice ${n}` : "Your invoice";
}

function days(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/** A reminder text for an overdue (or, sent by hand, a not-yet-due) invoice. PURE. */
export function reminderText(input: ReminderInput, tone: ReminderTone): string {
  const { businessName: b, invoiceNumber: n, link } = input;
  const amount = money(input.owingCents);
  if (input.daysOverdue <= 0) {
    const due = input.dueDate ? ` is due ${shortDate(input.dueDate)}` : " is ready";
    return plainText(`${hi(input.firstName)}, it's ${b}. Just a reminder that ${inv(n)} for ${amount}${due}. You can pay here: ${link} Thanks!`);
  }
  switch (tone) {
    case "gentle":
      return plainText(
        `${hi(input.firstName)}, it's ${b}. Just a friendly reminder that ${inv(n)} for ${amount}${input.dueDate ? ` was due ${shortDate(input.dueDate)}` : " is past due"}. You can pay here: ${link} Thanks!`,
      );
    case "nudge":
      return plainText(`${hi(input.firstName)}, ${b} here. ${Inv(n)} for ${amount} is now ${days(input.daysOverdue)} past due. Please pay here: ${link} If you've already sent it, thank you and please ignore this.`);
    case "firm":
      return plainText(`${hi(input.firstName)}, ${b} here. ${Inv(n)} (${amount}) is ${days(input.daysOverdue)} past due. Please pay today: ${link} Reply here if there's a problem.`);
    case "last":
    default:
      return plainText(`${hi(input.firstName)}, it's ${b}. ${Inv(n)} for ${amount} is ${days(input.daysOverdue)} past due. Please pay now: ${link} If it's easier, reply to set up a payment plan.`);
  }
}

/** The final notice (only ever sent with the owner's OK). PURE. */
export function finalNoticeText(input: ReminderInput): string {
  return plainText(
    `${hi(input.firstName)}, this is a final reminder from ${input.businessName}: ${inv(input.invoiceNumber)} for ${money(input.owingCents)} is now ${days(Math.max(1, input.daysOverdue))} past due. Please pay here: ${input.link} or reply to arrange a payment plan.`,
  );
}

/** "3 payments of $400.00" / "2 payments ($600.00 and $600.01)". PURE. */
export function planShape(instalments: Instalment[]): string {
  const amounts = [...new Set(instalments.map((i) => i.amountCents))];
  if (amounts.length === 1) return `${instalments.length} payments of ${money(amounts[0])}`;
  return `${instalments.length} payments (${listJoin(instalments.map((i) => money(i.amountCents)))})`;
}

export function planDates(instalments: Instalment[]): string {
  return listJoin(instalments.map((i) => shortDate(i.dueDate)));
}

export function planConfirmText(input: { businessName: string; firstName: string | null; ownerName: string | null; invoiceNumber: string | null; instalments: Instalment[]; link: string }): string {
  const who = input.ownerName ? `${input.ownerName} OK'd` : "We've set up";
  return plainText(
    `${hi(input.firstName)}, ${who} your payment plan for ${inv(input.invoiceNumber)}: ${planShape(input.instalments)}, due ${planDates(input.instalments)}. We'll text a reminder before each one. Pay here: ${input.link}`,
  );
}

export function planDeclinedText(input: { businessName: string; firstName: string | null; ownerName: string | null }): string {
  const who = input.ownerName ?? "Someone from the team";
  return plainText(`${hi(input.firstName)}, it's ${input.businessName}. ${who} will be in touch with you directly about the payment. Thanks for your patience.`);
}

export function instalmentText(input: { businessName: string; firstName: string | null; instalment: Instalment; of: number; today: string; link: string }): string {
  const when = input.instalment.dueDate === input.today ? "today" : input.instalment.dueDate < input.today ? `on ${shortDate(input.instalment.dueDate)}` : `${dayDate(input.instalment.dueDate)}`;
  const verb = input.instalment.dueDate < input.today ? "was due" : "is due";
  return plainText(
    `${hi(input.firstName)}, it's ${input.businessName}. Reminder: payment ${input.instalment.n} of ${input.of} on your plan (${money(input.instalment.amountCents)}) ${verb} ${when}. Pay here: ${input.link} Thanks!`,
  );
}
