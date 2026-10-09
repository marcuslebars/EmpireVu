/**
 * What the owner reads before they answer an approval — built in CODE from the payload, never
 * from the model's own summary, so "Y" does exactly what the text says:
 *   • send_reply   → the exact reply that will be sent (and any money the guard flagged);
 *   • send_quote   → the exact line labels and amounts (+ HST);
 *   • custom_price → the exact label the quote line will carry; the owner supplies the price;
 *   • book_job     → the date/time and the customer;
 *   • callback     → who, and their own words.
 * The customer's own words are quoted as context (capped). The model's one-liner is only shown
 * when there is nothing better, and labelled as the assistant's note. PURE.
 */
import type { ApprovalKind } from "@/server/services/front-desk/contracts";

/** A send_reply longer than this isn't put in front of the owner (shorten it, or hand off). */
export const MAX_APPROVAL_REPLY_CHARS = 300;
/** Budget for the whole owner text, before the platform prefix and the reply instruction. */
const MAX_SUMMARY_CHARS = 440;

/** Kinds where "Y $700" (a price note) means something. */
export const PRICE_NOTE_KINDS = new Set<string>(["custom_price", "send_quote"]);

export interface ApprovalLine {
  label: string;
  amountCents: number;
}

export interface ApprovalTextInput {
  kind: ApprovalKind;
  customerName: string;
  customerPhone: string | null;
  /** The customer's latest text(s) — context, quoted. */
  customerText?: string | null;
  /** The model's one-line note — shown only when nothing better is available. */
  modelNote?: string | null;
  /** send_reply: the exact text. */
  replyText?: string | null;
  /** Reasons the money guard flagged (send_reply). */
  moneyFlags?: string[];
  /** send_quote: the priced lines. */
  lines?: ApprovalLine[];
  subtotalCents?: number | null;
  /** custom_price / send_quote without lines: the quote line's label. */
  label?: string | null;
  /** book_job: when, already formatted for the owner. */
  when?: string | null;
  jobNote?: string | null;
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** "705-555-0123" from "+17055550123". */
export function prettyPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : phone ?? null;
}

function who(input: ApprovalTextInput): string {
  const phone = prettyPhone(input.customerPhone);
  if (!phone || input.customerName === input.customerPhone || input.customerName.replace(/\D/g, "").endsWith(phone.replace(/\D/g, ""))) return phone ?? input.customerName;
  return `${input.customerName} (${phone})`;
}

function context(input: ApprovalTextInput, max: number): string {
  if (input.customerText?.trim()) return ` Their text: "${clip(input.customerText, max)}"`;
  if (input.modelNote?.trim()) return ` Assistant's note: ${clip(input.modelNote, max)}`;
  return "";
}

/** The owner-facing text for a new approval (without the "Reply Y …" instruction). PURE. */
export function buildApprovalSummary(input: ApprovalTextInput): string {
  const name = who(input);
  let core: string;
  switch (input.kind) {
    case "send_reply": {
      const flags = input.moneyFlags?.length ? ` CHECK: ${input.moneyFlags.join("; ")}.` : "";
      core = `${name} - OK to text them exactly this? "${(input.replyText ?? "").trim()}"${flags}`;
      // The reply is never cut; only the context shrinks to fit.
      const room = MAX_SUMMARY_CHARS - core.length - 16;
      return room >= 30 && input.customerText?.trim() ? `${core}${context({ ...input, modelNote: null }, Math.min(120, room))}` : core;
    }
    case "send_quote": {
      if (input.lines?.length) {
        const lines = input.lines.map((l) => `${clip(l.label, 60)} ${dollars(l.amountCents)}`).join("; ");
        const total = typeof input.subtotalCents === "number" ? ` = ${dollars(input.subtotalCents)} + HST` : " + HST";
        core = `${name} - send them a quote: ${lines}${total}?`;
      } else {
        core = `${name} - send them a quote for "${clip(input.label, 80) || "the work"}"? You set the price.`;
      }
      break;
    }
    case "custom_price":
      core = `${name} wants a price. The quote will say "${clip(input.label, 80) || "Quoted work"}" at the price you give + HST.`;
      break;
    case "book_job":
      core = `${name} - book them for ${input.when?.trim() || "the time they asked for"}${input.jobNote?.trim() ? ` (${clip(input.jobNote, 80)})` : ""}?`;
      break;
    case "callback":
      core = `${name} wants a call back. Y tells them you'll call.`;
      break;
    default:
      core = `${name}: ${clip(input.modelNote, 200)}`;
  }
  const room = Math.max(60, Math.min(160, MAX_SUMMARY_CHARS - core.length - 20));
  return `${core}${context(input, room)}`;
}

/** The "Reply Y 12 …" line for a kind (the code is always shown). PURE. */
export function replyInstruction(kind: ApprovalKind, code: number | null, payload: Record<string, unknown> = {}): string {
  const c = code != null ? ` ${code}` : "";
  const hasLines = Array.isArray(payload.lines) && payload.lines.length > 0;
  switch (kind) {
    case "custom_price":
      return `Reply Y${c} $price (before HST) to send it, N${c} to skip.`;
    case "send_quote":
      return hasLines ? `Reply Y${c} to send it, N${c} to skip.` : `Reply Y${c} $price (before HST) to send it, N${c} to skip.`;
    case "send_reply":
      return `Reply Y${c} to send it, N${c} to skip.`;
    case "book_job":
      return `Reply Y${c} to book it, N${c} to skip.`;
    case "callback":
      return `Reply Y${c} to tell them, N${c} to skip.`;
    default:
      return `Reply Y${c} to approve, N${c} to skip.`;
  }
}
