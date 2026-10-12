/**
 * Every customer and owner text Customer care sends, built in code (no model). PURE.
 * Customer texts name the business, never the platform; plain GSM punctuation.
 */
import type { CareContact, OfferedSlot, VisitKind } from "./db-types";
import { longDate } from "./time";

const PHONE_LIKE = /^\+?\d[\d\s()-]{6,}$/;

/** A real first name (not a phone-number placeholder), or null. */
export function firstNameOf(contact: Pick<CareContact, "first_name"> | null): string | null {
  const f = contact?.first_name?.trim();
  return f && !PHONE_LIKE.test(f) ? f.split(/\s+/)[0] : null;
}

export function customerName(contact: Pick<CareContact, "first_name" | "last_name" | "phone"> | null): string {
  const first = contact?.first_name?.trim() && !PHONE_LIKE.test(contact.first_name.trim()) ? contact.first_name.trim() : "";
  return [first, contact?.last_name?.trim()].filter(Boolean).join(" ") || contact?.phone || "A customer";
}

/** Plain one-line text for a text message: no markup, links or control characters. */
export function plain(value: string | null | undefined, max = 200): string {
  const t = (value ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[<>{}[\]`"]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/**
 * What the job was, in a few words, from the booking title: "Roof replacement — Dana Jones" →
 * "roof replacement". Titles that are only a name / "Booking …" give null (→ "the job").
 */
export function jobLabelOf(title: string | null | undefined, contact?: Pick<CareContact, "first_name" | "last_name"> | null): string | null {
  let t = plain(title, 120);
  t = t.split(/\s+[—–-]\s+|\s*\(|:\s+/)[0]?.trim() ?? "";
  if (!t) return null;
  if (/^(booking|job|visit|appointment|callback|warranty visit)\b/i.test(t)) return null;
  const names = [contact?.first_name, contact?.last_name].filter((n): n is string => Boolean(n && n.trim().length > 1)).map((n) => n.trim().toLowerCase());
  if (names.some((n) => t.toLowerCase() === n || t.toLowerCase().includes(n))) return null;
  if (t.length > 40) t = t.slice(0, 40).replace(/\s+\S*$/, "");
  return t.toLowerCase();
}

/** "the roof replacement" / "the job". */
export function theJob(label: string | null): string {
  return label ? `the ${label}` : "the job";
}

/** The check-in text. */
export function checkinText(business: string, first: string | null, label: string | null): string {
  return `Hi${first ? ` ${first}` : ""}, it's ${plain(business, 60)} - how did ${theJob(label)} go? Reply 1-5 (5 = great), or tell us anything we missed.`;
}

/** The customer's words, quoted for the owner (data). */
export function quoted(words: string | null | undefined, max = 140): string | null {
  const t = plain(words, max).replace(/"/g, "'");
  return t ? `"${t}"` : null;
}

/** "Dana Jones rated the roof job 2/5: "still leaking by the chimney"." */
export function lowRatingLine(name: string, label: string | null, rating: number | null, comment: string | null): string {
  const job = label ? `the ${label} job` : "their job";
  const words = quoted(comment);
  if (rating != null) return `${name} rated ${job} ${rating}/5${words ? `: ${words}` : ""}.`;
  return `${name} isn't happy with ${job}${words ? `: ${words}` : ""}.`;
}

/** "Mike" / null → how the owner is named to the customer. */
function callerSentence(owner: string | null, verb: string): string {
  return owner ? `${owner} will ${verb}` : `We'll ${verb}`;
}

/** "Mike will call you today" — the call option's customer text, also quoted to the owner. */
export function callPromise(owner: string | null): string {
  return owner ? `${owner} will call you today` : "We'll call you today";
}

export function ownerCallText(business: string, first: string | null, owner: string | null, label: string | null): string {
  return `Hi${first ? ` ${first}` : ""}, it's ${plain(business, 60)}. ${callPromise(owner)} about ${theJob(label)}.`;
}

/** Warranty N / expiry: the customer is told the owner will call (no promise of when or what). */
export function willCallText(business: string, first: string | null, owner: string | null, label: string | null): string {
  return `Hi${first ? ` ${first}` : ""}, it's ${plain(business, 60)}. ${callerSentence(owner, "give you a call")} about ${theJob(label)}.`;
}

export function noTimesText(business: string, first: string | null, owner: string | null, label: string | null): string {
  return `Hi${first ? ` ${first}` : ""}, it's ${plain(business, 60)}. ${callerSentence(owner, "call you")} to set up a time to come back and look at ${theJob(label)}.`;
}

function joinOr(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** The visit offer: 2–3 open times from the calendar. */
export function visitOfferText(business: string, first: string | null, owner: string | null, label: string | null, kind: VisitKind, slots: OfferedSlot[]): string {
  const who = owner ? `${owner} would like` : "We'd like";
  const what = kind === "warranty" ? `to come back and look at ${theJob(label)} - no charge for the visit` : `to come back and take a look at ${theJob(label)}`;
  return `Hi${first ? ` ${first}` : ""}, it's ${plain(business, 60)}. ${who} ${what}. Would any of these work: ${joinOr(slots.map((s) => s.label))}? Just reply with the one that suits.`;
}

// ── Owner texts and approval summaries ────────────────────────────────────────────────

export function careFollowupSummary(option: "visit" | "call", alert: string, owner: string | null): string {
  return option === "visit"
    ? `${alert} Y books a callback visit (I'll text them times).`.slice(0, 500)
    : `${alert} Y texts them "${callPromise(owner)}."`.slice(0, 500);
}

/** One owner text carrying both care_followup codes. */
export function careFollowupOwnerText(alert: string, visitCode: number | null, callCode: number | null, owner: string | null): string {
  const v = visitCode ?? "?";
  const c = callCode ?? "?";
  return `${alert} Y ${v} books a callback visit (I'll text them times). Y ${c} texts them "${callPromise(owner)}." N ${v} to leave it.`;
}

export interface WarrantyFact {
  /** "job May 4, 2026; 12-month workmanship warranty to May 4, 2027" */
  text: string;
}

export function workmanshipFact(doneOn: string, months: number, endsOn: string): string {
  return `job ${longDate(doneOn)}; ${months}-month workmanship warranty to ${longDate(endsOn)}`;
}

export function equipmentFact(name: string, installedOn: string | null, endsOn: string): string {
  return `${name}${installedOn ? ` installed ${longDate(installedOn)}` : ""}; manufacturer warranty to ${longDate(endsOn)}`;
}

export function warrantyClaimSummary(name: string, problem: string | null, fact: string): string {
  const words = quoted(problem, 120);
  return `${name} says ${words ?? "there's a problem with past work"} (${fact}). Y books a no-charge warranty visit (I'll text them times), N and I'll tell them you'll call.`.slice(0, 500);
}

export function equipmentName(e: { make: string | null; model: string | null }): string {
  return plain([e.make, e.model].filter(Boolean).join(" "), 60) || "equipment";
}

export function bookedOwnerLine(name: string, kind: VisitKind, label: string): string {
  return `Booked ${name}'s ${kind === "warranty" ? "warranty" : "callback"} visit for ${label} (no charge - it won't be invoiced). It's pending on your calendar.`;
}

export function dateLabel(ymd: string): string {
  return longDate(ymd);
}
