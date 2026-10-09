/**
 * Quote email dispatch — loads the context, renders, sends, records the event.
 *
 * Failure policy differs by caller, deliberately:
 *
 *   sendQuoteEmail        THROWS. An admin pressed "Send"; if the mail didn't go
 *                         out they need to know immediately, because the customer
 *                         is now waiting for something that will never arrive.
 *
 *   receipt / replaced    BEST-EFFORT. These fire from a Stripe webhook and from
 *                         a reissue that has already mutated two rows. Throwing
 *                         would make Stripe retry (or leave a reissue half-done)
 *                         over a mail problem, which is worse than a missing
 *                         email — the money and the state are already correct.
 *
 * Every attempt writes a quote_event either way, so "did the customer get it?" is
 * answerable from the audit trail rather than from log archaeology.
 */
import { sendEmail } from "@/server/outbound/email";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { quotePublicBaseUrlFor } from "./config";
import { withPlatformBrand } from "./public-url";
import {
  renderDepositReceipt,
  renderExpiryReminder,
  renderQuoteReplaced,
  renderQuoteSent,
  type EmailBrand,
  type RenderedEmail,
} from "./emails";
import { recordPublicEvent } from "./public-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

interface Recipient {
  email: string;
  firstName: string | null;
}

interface QuoteEmailContextRow {
  quote: Db;
  company: Db | null;
  recipient: Recipient | null;
}

async function loadContext(quoteId: string): Promise<QuoteEmailContextRow | null> {
  const db = createSupabaseAdminClient() as Db;
  const { data: quote } = await db.from("quotes").select("*").eq("id", quoteId).maybeSingle();
  if (!quote) return null;

  const [{ data: company }, { data: contact }] = await Promise.all([
    quote.company_id
      ? db.from("companies").select("*").eq("id", quote.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    quote.contact_id
      ? db.from("contacts").select("email, first_name").eq("id", quote.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const email = typeof contact?.email === "string" ? contact.email.trim() : "";
  return {
    quote,
    // + the org's platform brand: a CrankLeads company's quote link uses its neutral host.
    company: company ? await withPlatformBrand(db, company) : null,
    recipient: email ? { email, firstName: contact?.first_name ?? null } : null,
  };
}

function brandOf(company: Db | null): EmailBrand {
  const str = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  return {
    name: str(company?.name),
    logoUrl: str(company?.brand_logo_url),
    primaryColor: str(company?.brand_primary_color),
    replyEmail: str(company?.brand_reply_email),
    replyPhone: str(company?.brand_reply_phone),
    websiteUrl: str(company?.brand_website_url),
  };
}

/** The customer link, on the quote's own brand domain when the company has one. */
function quoteUrl(token: string, company: Db | null): string {
  return `${quotePublicBaseUrlFor(company)}/q/${token}`;
}

async function deliver(quote: Db, to: string, mail: RenderedEmail): Promise<void> {
  await sendEmail({
    to,
    subject: mail.subject,
    body: mail.text,
    html: mail.html,
    fromName: mail.fromName ?? undefined,
    replyTo: mail.replyTo ?? undefined,
  });
}

/**
 * What happened to one email. `delivered: false` is never an error — the quote
 * it belongs to is already written and payable.
 */
export interface EmailOutcome {
  delivered: boolean;
  /** Operator-facing, present only when it did not go. */
  reason: string | null;
}

const NOT_DELIVERED = (reason: string): EmailOutcome => ({ delivered: false, reason });

/**
 * Render + send + record. NEVER THROWS.
 *
 * It used to rethrow for the admin path, and that was the bug: sendQuote writes
 * the status to 'sent' BEFORE calling this, so a throw here reported failure for
 * an operation that had already succeeded. A quote came back numbered, stamped
 * and payable while the API answered 500 — which invites an operator to press
 * Send again, or to assume a live quote does not exist.
 *
 * The email and the quote are separate concerns. A quote with no email address
 * is a normal quote whose link gets read out over the phone; a provider outage
 * is our problem, not a reason to hide the customer's quote. Both are reported
 * through the return value and the event log.
 */
async function dispatch(
  quoteId: string,
  kind: string,
  build: (ctx: QuoteEmailContextRow) => RenderedEmail,
): Promise<EmailOutcome> {
  const ctx = await loadContext(quoteId);
  if (!ctx) return NOT_DELIVERED(`Quote ${quoteId} not found.`);

  if (!ctx.recipient) {
    await recordPublicEvent(ctx.quote.organization_id, quoteId, `${kind}_skipped`, {
      reason: "contact has no email address",
    });
    return NOT_DELIVERED("No email address on file for this contact — share the quote link directly.");
  }

  try {
    const mail = build(ctx);
    await deliver(ctx.quote, ctx.recipient.email, mail);
    await recordPublicEvent(ctx.quote.organization_id, quoteId, `${kind}_sent`, {
      subject: mail.subject,
    });
    return { delivered: true, reason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never log the rendered body — it contains customer detail. The message is
    // capped for the same reason the event metadata is: a provider that echoes
    // the payload back in its error would otherwise put it in the log verbatim,
    // unbounded.
    console.error(`[quotes] ${kind} email failed for quote ${quoteId}: ${message.slice(0, 500)}`);
    await recordPublicEvent(ctx.quote.organization_id, quoteId, `${kind}_failed`, {
      error: message.slice(0, 500),
    });
    return NOT_DELIVERED(`The email could not be delivered: ${message.slice(0, 200)}`);
  }
}

/** The quote itself. Reports its outcome; the send already happened. */
export async function sendQuoteEmail(quoteId: string): Promise<EmailOutcome> {
  return dispatch(
    quoteId,
    "quote_email",
    ({ quote, company, recipient }) =>
      renderQuoteSent({
        brand: brandOf(company),
        quoteUrl: quoteUrl(quote.public_token, company),
        quoteNumber: quote.quote_number,
        title: quote.title,
        customerName: recipient?.firstName ?? null,
        currency: quote.currency ?? "CAD",
        introMessage: quote.intro_message,
        totalCents: quote.total_cents,
        depositCents: quote.deposit_cents,
        validUntil: quote.valid_until ?? quote.expires_at,
      }),
  );
}

/** Deposit receipt. Best-effort: the payment already succeeded. */
export async function sendDepositReceiptEmail(quoteId: string): Promise<EmailOutcome> {
  return dispatch(
    quoteId,
    "receipt_email",
    ({ quote, company, recipient }) => {
      // The FROZEN selection is what they bought — not the live line items.
      const lines = Array.isArray(quote.approved_line_items) ? quote.approved_line_items : [];
      const purchased = lines
        .filter((l: Db) => l.selected !== false)
        .map((l: Db) => ({ label: String(l.label ?? ""), amountCents: Number(l.amountCents ?? 0) }));

      const total = quote.approved_total_cents ?? quote.total_cents;
      const deposit = quote.approved_deposit_cents ?? quote.deposit_cents;

      return renderDepositReceipt({
        brand: brandOf(company),
        quoteUrl: quoteUrl(quote.public_token, company),
        quoteNumber: quote.quote_number,
        title: quote.title,
        customerName: recipient?.firstName ?? null,
        currency: quote.currency ?? "CAD",
        depositCents: deposit,
        totalCents: total,
        balanceCents: Math.max(0, total - deposit),
        purchasedLines: purchased,
      });
    },
  );
}

/** "We've updated your quote" — sent for the SUCCESSOR, best-effort. */
export async function sendQuoteReplacedEmail(
  successorQuoteId: string,
  reason: string | null,
): Promise<EmailOutcome> {
  return dispatch(
    successorQuoteId,
    "replaced_email",
    ({ quote, company, recipient }) =>
      renderQuoteReplaced({
        brand: brandOf(company),
        quoteUrl: quoteUrl(quote.public_token, company),
        quoteNumber: quote.quote_number,
        title: quote.title,
        customerName: recipient?.firstName ?? null,
        currency: quote.currency ?? "CAD",
        reason,
      }),
  );
}

/** Expiry reminder — one gentle nudge. Best-effort; a cron must not die on mail. */
export async function sendExpiryReminderEmail(quoteId: string, now = new Date()): Promise<EmailOutcome> {
  return dispatch(
    quoteId,
    "reminder_email",
    ({ quote, company, recipient }) =>
      renderExpiryReminder({
        brand: brandOf(company),
        quoteUrl: quoteUrl(quote.public_token, company),
        quoteNumber: quote.quote_number,
        title: quote.title,
        customerName: recipient?.firstName ?? null,
        currency: quote.currency ?? "CAD",
        validUntil: quote.valid_until ?? quote.expires_at,
        depositCents: quote.deposit_cents,
        now,
      }),
  );
}
