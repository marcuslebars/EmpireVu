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
import { getQuotesConfig } from "./config";
import {
  renderDepositReceipt,
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
    company: company ?? null,
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

function quoteUrl(token: string): string {
  return `${getQuotesConfig().publicBaseUrl}/q/${token}`;
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

/** Shared: render + send + record, with the caller deciding whether to rethrow. */
async function dispatch(
  quoteId: string,
  kind: string,
  build: (ctx: QuoteEmailContextRow) => RenderedEmail,
  { rethrow }: { rethrow: boolean },
): Promise<boolean> {
  const ctx = await loadContext(quoteId);
  if (!ctx) {
    if (rethrow) throw new Error(`Quote ${quoteId} not found.`);
    return false;
  }

  if (!ctx.recipient) {
    // No email on the contact. Recorded rather than thrown even for the admin
    // path: the quote itself is fine, and the operator needs the reason, not a
    // stack trace.
    await recordPublicEvent(ctx.quote.organization_id, quoteId, `${kind}_skipped`, {
      reason: "contact has no email address",
    });
    if (rethrow) {
      throw new Error("This contact has no email address, so the quote could not be sent.");
    }
    return false;
  }

  try {
    const mail = build(ctx);
    await deliver(ctx.quote, ctx.recipient.email, mail);
    await recordPublicEvent(ctx.quote.organization_id, quoteId, `${kind}_sent`, {
      subject: mail.subject,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never log the rendered body — it contains customer detail.
    console.error(`[quotes] ${kind} email failed for quote ${quoteId}: ${message}`);
    await recordPublicEvent(ctx.quote.organization_id, quoteId, `${kind}_failed`, {
      error: message.slice(0, 500),
    });
    if (rethrow) throw err;
    return false;
  }
}

/** The quote itself. Throws — the admin just pressed Send. */
export async function sendQuoteEmail(quoteId: string): Promise<boolean> {
  return dispatch(
    quoteId,
    "quote_email",
    ({ quote, company, recipient }) =>
      renderQuoteSent({
        brand: brandOf(company),
        quoteUrl: quoteUrl(quote.public_token),
        quoteNumber: quote.quote_number,
        title: quote.title,
        customerName: recipient?.firstName ?? null,
        currency: quote.currency ?? "CAD",
        introMessage: quote.intro_message,
        totalCents: quote.total_cents,
        depositCents: quote.deposit_cents,
        validUntil: quote.valid_until ?? quote.expires_at,
      }),
    { rethrow: true },
  );
}

/** Deposit receipt. Best-effort: the payment already succeeded. */
export async function sendDepositReceiptEmail(quoteId: string): Promise<boolean> {
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
        quoteUrl: quoteUrl(quote.public_token),
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
    { rethrow: false },
  );
}

/** "We've updated your quote" — sent for the SUCCESSOR, best-effort. */
export async function sendQuoteReplacedEmail(
  successorQuoteId: string,
  reason: string | null,
): Promise<boolean> {
  return dispatch(
    successorQuoteId,
    "replaced_email",
    ({ quote, company, recipient }) =>
      renderQuoteReplaced({
        brand: brandOf(company),
        quoteUrl: quoteUrl(quote.public_token),
        quoteNumber: quote.quote_number,
        title: quote.title,
        customerName: recipient?.firstName ?? null,
        currency: quote.currency ?? "CAD",
        reason,
      }),
    { rethrow: false },
  );
}
