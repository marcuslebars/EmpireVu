/**
 * Every owner-facing line the Email inbox writes (PURE). Email content is untrusted: every piece
 * of it goes through `clean` (no links, no markup, capped) before it reaches an owner text.
 */
import type { EmailCategory, InboundEmailRow } from "./db-types";
import { clean } from "./parse";

export const EMAIL_REPLY_KIND = "email_reply";
/** Approval summaries are capped at 500 by insertApproval; stay under it. */
export const MAX_SUMMARY = 490;
export const DRAFT_PREVIEW_CHARS = 220;

export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-30" → "Oct 30". */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

/** "2026-10-16" → "Fri Oct 16" (or "Fri" within the week, when `today` is given). */
export function dayLabel(date: string, today?: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  const wd = DAYS[at.getUTCDay()];
  if (today) {
    const diff = Math.round((at.getTime() - new Date(`${today}T12:00:00Z`).getTime()) / 86_400_000);
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff > 1 && diff < 7) return wd;
  }
  return `${wd} ${shortDate(date)}`;
}

/** "Dana Jones" / "dana@example.com" — who sent it, for the owner. */
export function senderLabel(row: Pick<InboundEmailRow, "from_name" | "from_address">): string {
  return clean(row.from_name, 40) || clean(row.from_address, 60) || "someone";
}

/** What they want in a few words: the model's summary, else the subject, else the start of the text. */
export function askOf(row: Pick<InboundEmailRow, "ai_summary" | "subject" | "text_body">, max = 110): string {
  return clean(row.ai_summary, max) || clean(row.subject, max) || clean(row.text_body, max) || "(no subject)";
}

/** One line of the draft for the owner's text: the first ~220 characters, on one line. */
export function draftPreview(draft: string, max = DRAFT_PREVIEW_CHARS): string {
  return clean(draft, max);
}

/**
 * The email_reply approval summary (the reply instruction is added by notify):
 *   Email from Dana Jones: "Can you quote a full roof on 12 Bay St?" Draft: "Hi Dana, thanks…"
 *   Full draft: https://app…
 */
export function replySummary(input: { sender: string; ask: string; draft: string; link: string | null; replaced: boolean }): string {
  const tail = `${input.replaced ? " (It needs your price, so the draft says you'll get back to them.)" : ""}${input.link ? ` Full draft: ${input.link}` : ""}`;
  const head = `Email from ${input.sender}: "${input.ask}" Draft: "`;
  const room = Math.max(60, Math.min(DRAFT_PREVIEW_CHARS, MAX_SUMMARY - head.length - tail.length - 2));
  return `${head}${draftPreview(input.draft, room)}"${tail}`.slice(0, MAX_SUMMARY);
}

/** The text the owner gets as an email arrives (customer without a draft, bid invite, supplier on a PO). */
export function alertLine(row: Pick<InboundEmailRow, "category" | "from_name" | "from_address" | "ai_summary" | "subject" | "text_body" | "detail">, opts: { today: string; inboxLink?: string | null; task?: boolean }): string {
  const who = senderLabel(row);
  const d = row.detail ?? {};
  switch (row.category as EmailCategory) {
    case "customer":
      return `Email from ${who}: "${askOf(row)}"${opts.inboxLink ? ` Answer it in the app: ${opts.inboxLink}` : " It's in your app inbox."}`;
    case "bid_invite": {
      const gc = clean(d.from_business, 40) || who;
      const what = clean(d.project, 60) || askOf(row, 80);
      const due = d.due_on ? `, due ${dayLabel(d.due_on, opts.today)}` : "";
      return `Bid invite: ${gc} - ${what}${due}.${opts.task ? " It's on your task list." : ""}`;
    }
    case "supplier": {
      const from = clean(d.from_business, 40) || who;
      return `${from} emailed${d.po_number ? ` about ${d.po_number}` : ""}: "${askOf(row, 120)}"`;
    }
    case "bill": {
      const from = clean(d.from_business, 40) || who;
      return `Bill from ${from}${typeof d.amount_cents === "number" ? ` ${money(d.amount_cents)}` : ""}${d.due_on ? ` due ${shortDate(d.due_on)}` : ""}`;
    }
    default:
      return `Email from ${who}: "${askOf(row, 100)}"`;
  }
}

/** Several held lines in one morning text. */
export function heldText(lines: string[]): string {
  const shown = lines.slice(0, 4);
  const more = lines.length > shown.length ? ` +${lines.length - shown.length} more in the app.` : "";
  return `Overnight email: ${shown.join(" / ")}${more}`;
}

/** Gmail / Outlook forwarding confirmation → the owner. We never click anything in the email. */
export function forwardingText(input: { provider: string | null; code: string | null; address: string; forwardedFrom?: string | null }): string {
  const who = input.forwardedFrom ? clean(input.forwardedFrom, 80) : null;
  if (input.provider === "gmail") {
    return input.code
      ? `Gmail${who ? ` (${who})` : ""} wants to confirm forwarding to your business inbox. Code: ${input.code}. In Gmail: Settings > See all settings > Forwarding and POP/IMAP, enter the code, Verify, then choose "Forward a copy of incoming mail to" ${input.address} and Save. Didn't ask for this? Ignore it.`
      : `Gmail${who ? ` (${who})` : ""} sent a forwarding confirmation for ${input.address}, but I couldn't read the code. In Gmail: Settings > See all settings > Forwarding and POP/IMAP > Verify, and use "Re-send email".`;
  }
  return `Outlook sent a code to confirm forwarding to your business inbox: ${input.code}. Enter it where Outlook asks, then turn forwarding on to ${input.address}. Didn't ask for this? Ignore it.`;
}

const IGNORED: EmailCategory[] = ["newsletter", "auto_reply", "bounce", "no_reply", "spam"];

export interface DigestInput {
  today: string;
  rows: Array<Pick<InboundEmailRow, "category" | "from_name" | "from_address" | "ai_summary" | "subject" | "text_body" | "detail">>;
}

/**
 * "Email today: 2 suppliers (PO-3 confirmed), 1 bill (Rona $412 due Oct 30), 5 newsletters
 * ignored." Null when there's nothing worth a text (only junk). ≤ 600 chars.
 */
export function digestText(input: DigestInput): string | null {
  const by = (c: EmailCategory) => input.rows.filter((r) => r.category === c);
  const suppliers = by("supplier");
  const bills = by("bill");
  const others = by("other");
  const ignored = input.rows.filter((r) => r.category && IGNORED.includes(r.category));
  if (suppliers.length + bills.length + others.length === 0) return null;
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const detail = (items: string[]) => (items.length ? ` (${items.slice(0, 2).join("; ")}${items.length > 2 ? "; …" : ""})` : "");
  if (suppliers.length) {
    parts.push(
      `${plural(suppliers.length, "supplier", "suppliers")}${detail(
        suppliers.map((r) => {
          const d = r.detail ?? {};
          const from = clean(d.from_business, 30) || senderLabel(r);
          return d.po_number ? `${d.po_number} ${askOf(r, 40)}` : `${from}: ${askOf(r, 40)}`;
        }),
      )}`,
    );
  }
  if (bills.length) {
    parts.push(
      `${plural(bills.length, "bill", "bills")}${detail(
        bills.map((r) => {
          const d = r.detail ?? {};
          const from = clean(d.from_business, 30) || senderLabel(r);
          return `${from}${typeof d.amount_cents === "number" ? ` ${money(d.amount_cents)}` : ""}${d.due_on ? ` due ${shortDate(d.due_on)}` : ""}`;
        }),
      )}`,
    );
  }
  if (others.length) {
    parts.push(
      `${plural(others.length, "other email", "other emails")}${detail(
        others.map((r) => `${r.detail?.reason === "unverified sender" ? "unverified sender: " : ""}${senderLabel(r)}: ${askOf(r, 40)}`),
      )}`,
    );
  }
  if (ignored.length) {
    const allNews = ignored.every((r) => r.category === "newsletter");
    parts.push(`${ignored.length} ${allNews ? (ignored.length === 1 ? "newsletter" : "newsletters") : "newsletters/automatic emails"} ignored`);
  }
  const text = `Email today: ${parts.join(", ")}. Text "email status" for more.`;
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

/** The step-by-step forwarding setup (owner tool `email_setup` and Settings). */
export function setupText(address: string, confirmed: boolean): string {
  return [
    `Your business inbox: ${address}${confirmed ? " (forwarding is working)" : ""}.`,
    `Gmail: Settings > See all settings > Forwarding and POP/IMAP > Add a forwarding address > paste it > Next. I'll text you Gmail's code - enter it, Verify, pick "Forward a copy", Save.`,
    `Outlook: Settings > Mail > Forwarding > Enable forwarding > paste it > tick Keep a copy > Save.`,
    `Customer emails then come to your app inbox with a reply ready for your Y.`,
  ].join(" ");
}
