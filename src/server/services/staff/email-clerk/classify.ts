/**
 * What an inbound email is (docs/ai-staff.md → "Email inbox"). Deterministic rules first; only
 * what they can't place goes to the model (ai.ts), and without a model a keyword fallback decides.
 *
 *   1. forwarding confirmation (Gmail "Gmail Forwarding Confirmation", a Microsoft forwarding code)
 *      — only from Google's / Microsoft's own senders, and never when the sender failed DKIM/DMARC.
 *   2. bounces, auto-replies, spam flags, our own mail looping back → stored, no action.
 *   3. a supplier (address or company domain, or a PO-n of ours in it) → supplier.
 *   4. a known customer (contact with that email) → customer.
 *   5. mailing lists / bulk → newsletter.
 *   6. the rest → the model; no-reply senders can never be a "customer" (nobody to answer).
 *
 * PURE. Everything about the email is untrusted data.
 */
import type { EmailCategory, EmailDetail } from "./db-types";
import { domainOf, FREEMAIL_DOMAINS, isNoReplyAddress, normalizeAddress, poNumbersIn } from "./parse";

export interface EmailFacts {
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  /** The whole text (quoted history included). */
  text: string;
  headers: Record<string, string>;
  auth: { spf?: string | null; dkim?: string | null; dmarc?: string | null } | null;
}

export interface ClassifyContext {
  inboxAddress: string;
  inboundDomain: string | null;
  /** The address our outbound mail is sent from (OUTBOUND_FROM_EMAIL), to catch loops. */
  outboundFrom: string | null;
  ownerEmail: string | null;
  suppliers: Array<{ id: string; name: string; branch: string | null; email: string | null }>;
  /** The company's purchase orders that a PO-n in the email could mean. */
  purchaseOrders: Array<{ id: string; po_number: string; supplier_id: string | null; status: string }>;
  /** A contact of this company has the sender's address (only used when the sender is verified). */
  knownContact: boolean;
  /** The owner's mailbox that forwards here (email_inboxes.forwarded_from): mail from it, or its company domain, is internal. */
  forwardedFrom?: string | null;
}

export interface RuleResult {
  category: EmailCategory;
  detail: EmailDetail;
  supplierId?: string | null;
  purchaseOrderId?: string | null;
  /** Forwarding confirmation code — texted to the owner, never stored. */
  code?: string | null;
}

export interface Classification {
  rule: RuleResult | null;
  /** The sender can't be answered (no-reply / notifications): never "customer". */
  noReply: boolean;
  /** A PO-n of ours that the email names (for the model path too). */
  po: ClassifyContext["purchaseOrders"][number] | null;
  /** DKIM/DMARC say the From is real. An unverified sender is never treated as a customer. */
  verified: boolean;
}

/** Google's and Microsoft's own system senders for forwarding checks (exact addresses only). */
const GOOGLE_FORWARDING = new Set(["forwarding-noreply@google.com"]);
const MICROSOFT_FORWARDING = new Set(["account-security-noreply@accountprotection.microsoft.com"]);

/**
 * The sender is who the From says: Resend's check says DKIM or DMARC passed and DMARC didn't fail.
 * No result (or neither passed) → unverified. PURE.
 */
export function senderVerified(auth: EmailFacts["auth"]): boolean {
  if (!auth) return false;
  if (auth.dmarc === "fail") return false;
  return auth.dkim === "pass" || auth.dmarc === "pass";
}

/** Gmail: "(#123456789) Gmail Forwarding Confirmation - Receive Mail from dana@gmail.com". PURE. */
export function gmailConfirmation(f: EmailFacts): { code: string | null; forwardedFrom: string | null } | null {
  const from = normalizeAddress(f.fromAddress);
  if (!from || !GOOGLE_FORWARDING.has(from)) return null;
  if (!/forwarding confirmation/i.test(f.subject ?? "")) return null;
  const code = /\(#(\d{6,12})\)/.exec(f.subject ?? "")?.[1] ?? /confirmation code:?\s*(\d{6,12})/i.exec(f.text)?.[1] ?? null;
  const forwardedFrom = normalizeAddress(/receive mail from\s+(\S+@\S+)/i.exec(f.subject ?? "")?.[1] ?? /^(\S+@\S+) has requested/im.exec(f.text)?.[1] ?? null);
  return { code, forwardedFrom };
}

/** Microsoft (Outlook.com / 365) forwarding verification with a code. PURE. */
export function microsoftConfirmation(f: EmailFacts): { code: string } | null {
  const from = normalizeAddress(f.fromAddress);
  if (!from || !MICROSOFT_FORWARDING.has(from)) return null;
  const words = `${f.subject ?? ""}\n${f.text}`;
  if (!/forward/i.test(words) || !/(verif|confirm)/i.test(words)) return null;
  const code = /\b(?:security|verification|confirmation)\s+code\s*(?:is)?\s*[:-]?\s*(\d{4,10})\b/i.exec(words)?.[1];
  return code ? { code } : null;
}

/** "Unsubscribe" / "stop emailing me" / "remove me from your list" — a clear email opt-out. PURE. */
export function asksToStop(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 400) return false;
  return /\b(unsubscribe|opt[\s-]?out|stop (e-?mailing|sending|contacting|messaging)|remove me|take me off|(do not|don't|dont|never) (e-?mail|contact|message) (me|us)( again)?|no more e-?mails?)\b/i.test(t);
}

function header(f: EmailFacts, name: string): string {
  return (f.headers[name] ?? "").toLowerCase();
}

export function isBounce(f: EmailFacts): boolean {
  const local = (normalizeAddress(f.fromAddress) ?? "").split("@")[0];
  if (/^(mailer-daemon|postmaster)$/i.test(local)) return true;
  if (/multipart\/report/i.test(header(f, "content-type")) && /delivery-status/i.test(header(f, "content-type"))) return true;
  return /^(undeliver(able|ed)|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice|delivery failure)/i.test((f.subject ?? "").trim());
}

export function isAutoReply(f: EmailFacts): boolean {
  const auto = header(f, "auto-submitted");
  if (auto && auto !== "no") return true;
  if (f.headers["x-autoreply"] || f.headers["x-autorespond"] || f.headers["x-autoresponder"]) return true;
  if (/auto_reply|auto-reply/.test(header(f, "precedence"))) return true;
  if (f.headers["x-auto-response-suppress"] && /^(automatic reply|auto)/i.test((f.subject ?? "").trim())) return true;
  return /^(automatic reply|auto(-|matic )?reply|autoreply|auto:|out of (the )?office|ooo\b)/i.test((f.subject ?? "").trim());
}

export function isSpamFlagged(f: EmailFacts): boolean {
  return /^yes/.test(header(f, "x-spam-flag")) || /^yes/.test(header(f, "x-spam-status")) || /^\s*(\[spam\]|\*{2,}\s*spam)/i.test(f.subject ?? "");
}

export function isBulk(f: EmailFacts): boolean {
  return Boolean(f.headers["list-unsubscribe"] || f.headers["list-id"]) || /^(bulk|list|junk)$/.test(header(f, "precedence").trim());
}

function supplierFor(f: EmailFacts, ctx: ClassifyContext): ClassifyContext["suppliers"][number] | null {
  const from = normalizeAddress(f.fromAddress);
  if (!from) return null;
  const exact = ctx.suppliers.find((s) => normalizeAddress(s.email) === from);
  if (exact) return exact;
  const domain = domainOf(from);
  if (!domain || FREEMAIL_DOMAINS.has(domain)) return null;
  return ctx.suppliers.find((s) => domainOf(s.email) === domain) ?? null;
}

/** The rules (and the facts the model path needs). PURE. */
export function classifyByRules(f: EmailFacts, ctx: ClassifyContext): Classification {
  const from = normalizeAddress(f.fromAddress);
  const noReply = isNoReplyAddress(from);
  const named = poNumbersIn(`${f.subject ?? ""}\n${f.text}`);
  const po = ctx.purchaseOrders.find((p) => named.includes(p.po_number)) ?? null;
  const verified = senderVerified(f.auth);
  const done = (rule: RuleResult): Classification => ({ rule, noReply, po, verified });

  // A forwarding check comes only from Google's / Microsoft's exact system sender, signed (DKIM or
  // DMARC pass), and never from someone we know.
  if (!(ctx.knownContact && verified)) {
    const gmail = gmailConfirmation(f);
    if (gmail) {
      if (!verified) return done({ category: "spam", detail: { reason: "unsigned forwarding confirmation" } });
      return done({ category: "forwarding_confirmation", detail: { provider: "gmail", forwarded_from: gmail.forwardedFrom }, code: gmail.code });
    }
    const ms = microsoftConfirmation(f);
    if (ms) {
      if (!verified) return done({ category: "spam", detail: { reason: "unsigned forwarding confirmation" } });
      return done({ category: "forwarding_confirmation", detail: { provider: "outlook" }, code: ms.code });
    }
  }
  if (isBounce(f)) return done({ category: "bounce", detail: {} });
  if (isAutoReply(f)) return done({ category: "auto_reply", detail: {} });
  if (isSpamFlagged(f)) return done({ category: "spam", detail: { reason: "flagged as spam" } });
  // Our own mail looping back (a reply we sent, bounced through someone's forwarding).
  const outbound = normalizeAddress(ctx.outboundFrom);
  if (from && (from === ctx.inboxAddress || (ctx.inboundDomain && from.endsWith(`@${ctx.inboundDomain}`)) || (outbound && from === outbound))) {
    return done({ category: "no_reply", detail: { reason: "our own mail" } });
  }
  if (from && ctx.ownerEmail && from === normalizeAddress(ctx.ownerEmail)) return done({ category: "other", detail: { reason: "from you" } });
  // The owner's own forwarding mailbox, or (a company domain) their staff.
  const fwd = normalizeAddress(ctx.forwardedFrom);
  const fwdDomain = domainOf(fwd);
  if (from && fwd && (from === fwd || (fwdDomain && !FREEMAIL_DOMAINS.has(fwdDomain) && domainOf(from) === fwdDomain))) {
    return done({ category: "other", detail: { reason: "from you or your staff" } });
  }

  const supplier = supplierFor(f, ctx);
  if (supplier || po) {
    const s = supplier ?? (po?.supplier_id ? ctx.suppliers.find((x) => x.id === po.supplier_id) ?? null : null);
    return done({
      category: "supplier",
      detail: { from_business: s ? (s.branch ? `${s.name} (${s.branch})` : s.name) : null, po_number: po?.po_number ?? null },
      supplierId: s?.id ?? null,
      purchaseOrderId: po?.id ?? null,
    });
  }
  if (ctx.knownContact && verified && !noReply && !isBulk(f)) return done({ category: "customer", detail: {} });
  if (isBulk(f)) return done({ category: "newsletter", detail: {} });
  return { rule: null, noReply, po, verified };
}

// ── Without a model ─────────────────────────────────────────────────────────────

const BILL_WORDS = /\b(invoice|bill|statement|amount due|balance due|payment due|due date|past due|pay now|remittance)\b/i;
const BID_WORDS = /\b(invitation to (bid|tender|quote)|request for (quotation|quote|proposal|pricing)|rfq|rfp|itb|tender|bid (invite|invitation|request|due|date|documents?)|bids? (are )?due|bidding|pre-?bid)\b/i;
const WORK_WORDS = /\b(quote|estimate|price|pricing|cost|how much|available|availability|book|schedule|appointment|come (out|by)|job|work|repair|install|replace|fix|leak|service|visit|look at)\b/i;
const MARKETING_WORDS = /\b(unsubscribe|newsletter|% off|sale ends|limited time|webinar|view in (your )?browser)\b/i;

/** Keyword guess when the model isn't available. PURE. */
export function fallbackCategory(f: EmailFacts, noReply: boolean): EmailCategory {
  const words = `${f.subject ?? ""}\n${f.text}`.slice(0, 6000);
  if (BID_WORDS.test(words)) return "bid_invite";
  if (BILL_WORDS.test(words) && /\$\s?\d/.test(words)) return "bill";
  if (MARKETING_WORDS.test(words)) return "newsletter";
  if (noReply) return "no_reply";
  if (WORK_WORDS.test(words)) return "customer";
  return "other";
}
