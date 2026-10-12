/**
 * Every text Service plans sends, built in CODE (never by a model). Plain GSM, short, contractor
 * voice, the business's own name (never the platform's). PURE.
 */
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import type { PlanBilling } from "./db-types";
import { dayText, longDate, money, monthsText, partOfDay, priceText, shortDate, visitName } from "./schedule";

export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^\+?\d[\d\s()-]{6,}$/.test(first) ? "" : first;
}

function hi(first: string): string {
  return first ? `Hi ${first}` : "Hi";
}

/** GSM-safe: curly quotes, dashes and the like → plain ASCII. */
export function plain(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export interface ConfirmationInput {
  firstName: string;
  businessName: string;
  planName: string;
  firstVisit: string | null;
  timeOfDay: string;
  planMonths: number[];
  /** Annual plans not paid online: the invoice to pay. */
  invoice?: { totalCents: number; url: string } | null;
}

/** "Hi Dana, you're signed up for Spring + Fall Lawn Care with Northshore Lawn. Your spring visit is booked for Tue May 4, morning - we'll text you before each one. Questions? Just reply." */
export function confirmationText(input: ConfirmationInput): string {
  const visit = input.firstVisit
    ? ` Your ${visitName(input.firstVisit, input.planMonths)} is booked for ${dayText(input.firstVisit)}, ${partOfDay(input.timeOfDay)} - we'll text you before each one.`
    : " We'll text you before each visit.";
  const pay = input.invoice ? ` Your invoice for the year (${money(input.invoice.totalCents)}) is here: ${input.invoice.url}` : "";
  return plain(`${hi(input.firstName)}, you're signed up for ${input.planName} with ${input.businessName}.${visit}${pay} Questions? Just reply.`);
}

/** "Hi Dana, it's Northshore Lawn. Your spring visit is booked for Tue May 5, morning. Reply to change." */
export function headsUpText(input: { firstName: string; businessName: string; date: string; timeOfDay: string; planMonths: number[] }): string {
  return plain(`${hi(input.firstName)}, it's ${input.businessName}. Your ${visitName(input.date, input.planMonths)} is booked for ${dayText(input.date)}, ${partOfDay(input.timeOfDay)}. Reply to change.`);
}

export interface RenewalTextInput {
  firstName: string;
  businessName: string;
  planName: string;
  billing: PlanBilling;
  priceCents: number;
  /** The first day of the new term. */
  renewsOn: string;
  /** The next term's first visit, for "pay now to keep your spring visit". */
  nextVisit: string | null;
  planMonths: number[];
  link: string;
}

/**
 * Annual: "Hi Dana, it's Northshore Lawn. Your Spring + Fall Lawn Care plan renews Nov 1 ($420 + HST
 * for the next year). Pay here to keep your spring visit: <link>"
 * Per visit: "… renews Nov 1 (still $95 + HST a visit). Tap here to keep it for another year: <link>"
 */
export function renewalText(input: RenewalTextInput): string {
  const keep = input.nextVisit ? `keep your ${visitName(input.nextVisit, input.planMonths)}` : "keep your plan";
  const body =
    input.billing === "annual"
      ? `Your ${input.planName} plan renews ${shortDate(input.renewsOn)} (${money(input.priceCents)} + HST for the next year). Pay here to ${keep}: ${input.link}`
      : `Your ${input.planName} plan renews ${shortDate(input.renewsOn)} (${money(input.priceCents)} + HST a visit). Tap here to ${keep}: ${input.link}`;
  return plain(`${hi(input.firstName)}, it's ${input.businessName}. ${body}`);
}

/** "Thanks Dana - your Spring + Fall Lawn Care plan with Northshore Lawn is renewed through Oct 31, 2028. Next visit: Tue May 4, morning." */
export function renewedText(input: { firstName: string; businessName: string; planName: string; termEnd: string; nextVisit: string | null; timeOfDay: string }): string {
  const next = input.nextVisit ? ` Next visit: ${dayText(input.nextVisit)}, ${partOfDay(input.timeOfDay)}.` : "";
  return plain(`Thanks${input.firstName ? ` ${input.firstName}` : ""} - your ${input.planName} plan with ${input.businessName} is renewed through ${longDate(input.termEnd)}.${next}`);
}

/** A sign-up the owner said no to (or didn't answer). The owner's note is never passed on. */
export function declinedText(input: { firstName: string; businessName: string; planName: string }): string {
  return plain(`${hi(input.firstName)}, thanks for signing up for ${input.planName}. ${input.businessName} will be in touch with you directly about it.`);
}

// ── Owner-facing (approval summaries, ≤ 500 chars without the reply line) ────

export interface SignupSummaryInput {
  customerName: string;
  customerPhone: string | null;
  planName: string;
  billing: PlanBilling;
  priceCents: number;
  months: number[];
  firstVisit: string | null;
  /** Annual plan with no online payment: Y also sends the first-year invoice. */
  sendsInvoice?: boolean;
  ownerAsked?: boolean;
}

/** "New plan sign-up: Dana Jones (705-555-0123), Spring + Fall Lawn Care $420/yr (May + Oct). Y starts the plan, books the visits (first: Tue May 4) and texts them to confirm." */
export function signupSummary(input: SignupSummaryInput): string {
  const phone = prettyPhone(input.customerPhone);
  const who = phone && phone !== input.customerName ? `${input.customerName} (${phone})` : input.customerName;
  const head = input.ownerAsked ? `Sign ${who} up for` : `New plan sign-up: ${who},`;
  const first = input.firstVisit ? ` (first: ${dayText(input.firstVisit)})` : "";
  const invoice = input.sendsInvoice ? `, sends their first-year invoice` : "";
  return plain(`${head} ${input.planName} ${priceText(input.priceCents, input.billing)} (${monthsText(input.months)}). Y starts the plan, books the visits${first}${invoice} and texts them to confirm.`).slice(0, 500);
}

export interface RenewalLine {
  name: string;
  renewsOn: string;
  priceCents: number;
  billing: PlanBilling;
  /** "spring visit": the next term's first visit, when known. */
  nextVisitName?: string | null;
}

/**
 * "3 plans renew in the next 30 days ($1,260): Dana Jones Nov 1 $420/yr; …. Y texts each customer
 * their renewal link (pay now to keep their spring visit)." Lines that don't fit fold into "+N more".
 */
export function renewalsSummary(lines: RenewalLine[], windowDays: number): string {
  const annual = lines.filter((l) => l.billing === "annual").reduce((s, l) => s + l.priceCents, 0);
  const count = `${lines.length} plan${lines.length === 1 ? "" : "s"} renew${lines.length === 1 ? "s" : ""} in the next ${windowDays} days${annual ? ` (${money(annual)})` : ""}`;
  const names = [...new Set(lines.map((l) => l.nextVisitName ?? ""))];
  const keep = names.length === 1 && names[0] ? names[0] : "next visit";
  const tail = `. Y texts each customer their renewal link (pay now to keep their ${keep}).`;
  const budget = 480 - count.length - tail.length - 3;
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const part = `${l.name} ${shortDate(l.renewsOn)} ${priceText(l.priceCents, l.billing)}`;
    const rest = lines.length - i - 1;
    const more = rest > 0 ? `; +${rest} more` : "";
    if ([...parts, part].join("; ").length + more.length > budget) {
      parts.push(`+${lines.length - i} more`);
      break;
    }
    parts.push(part);
  }
  return plain(`${count}: ${parts.join("; ")}${tail}`).slice(0, 500);
}
