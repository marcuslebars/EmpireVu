/**
 * SANCTIONED EXCEPTION (service role): the public invoice page /i/{token} and its
 * payments.
 *
 * The customer has no session — the unguessable token IS the credential, exactly
 * as for quotes (see quotes/public-service.ts). So every function here:
 *   • looks an invoice up ONLY by exact public_token (never by an id from the request),
 *   • never exposes a draft (a draft isn't issued yet),
 *   • returns the narrowed InvoiceDocument — no internal ids, no Stripe ids,
 *   • takes the amount to charge from the database, never from the request.
 *
 * The Stripe webhook handlers at the bottom have no session either; the event
 * signature is the credential, and each one cross-checks that the connected
 * account the event came from owns the invoice before touching it.
 *
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 */
import type Stripe from "stripe";

import { getCompanyStripeConfig, getPlatformStripe, onAccount, requireChargeableCompany } from "@/server/services/quotes/company-stripe";
import { UserFacingError } from "@/server/errors";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import {
  emitInvoiceTrigger,
  invoicePublicUrl,
  loadCompanyForInvoice,
  readBillTo,
  recordInvoiceEvent,
  refreshInvoiceBalance,
  type Db,
  type InvoiceRow,
} from "./common";
import { buildInvoiceDocument, type InvoiceDocument } from "./document";
import { sendPaymentReceiptEmail } from "./notify";
import { renderInvoicePdf } from "./pdf";

const admin = (): Db => createSupabaseAdminClient() as unknown as Db;

const TOKEN_RE = /^[a-f0-9]{32}$/;

async function invoiceByToken(db: Db, token: string): Promise<InvoiceRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await db.from("invoices").select("*").eq("public_token", token).maybeSingle();
  if (error) throw error;
  if (!data || data.status === "draft") return null;
  return data;
}

/**
 * The page's data. The first open of a sent invoice marks it viewed (once).
 */
export async function getPublicInvoice(token: string, opts: { markViewed?: boolean } = {}): Promise<InvoiceDocument | null> {
  const db = admin();
  let invoice = await invoiceByToken(db, token);
  if (!invoice) return null;

  if (opts.markViewed !== false && !invoice.first_viewed_at && invoice.status !== "void") {
    const { data: claimed } = await db
      .from("invoices")
      .update({ first_viewed_at: new Date().toISOString() })
      .eq("id", invoice.id)
      .is("first_viewed_at", null)
      .select("id")
      .maybeSingle();
    if (claimed) {
      invoice = await refreshInvoiceBalance(db, invoice.id);
      await recordInvoiceEvent(db, { organizationId: invoice.organization_id, invoiceId: invoice.id, eventType: "viewed" });
    }
  }

  const company = await loadCompanyForInvoice(db, invoice.organization_id, invoice.company_id);
  return buildInvoiceDocument(invoice, company);
}

export async function getPublicInvoicePdf(token: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const db = admin();
  const invoice = await invoiceByToken(db, token);
  if (!invoice) return null;
  const company = await loadCompanyForInvoice(db, invoice.organization_id, invoice.company_id);
  const bytes = await renderInvoicePdf(buildInvoiceDocument(invoice, company));
  return { bytes, filename: `${(invoice.invoice_number ?? "invoice").replace(/[^A-Za-z0-9-]/g, "")}.pdf` };
}

// ── Checkout ─────────────────────────────────────────────────────────────────

export type OnlineMethod = "card" | "bank_debit";

/**
 * A payment the customer can't start, with a message written for them (it is shown
 * on the public pay page as-is). → 404 for not_found, 409 otherwise.
 */
export class InvoiceCheckoutError extends UserFacingError {
  constructor(
    message: string,
    override readonly code: "not_found" | "not_payable" | "nothing_owing" | "method_unavailable",
  ) {
    super(message, { status: code === "not_found" ? 404 : 409, code });
    this.name = "InvoiceCheckoutError";
  }
}

/** What a customer sees when bank debit can't be started for any reason. */
export const BANK_DEBIT_UNAVAILABLE_MESSAGE =
  "Bank debit isn't available for this invoice right now. Please pay by card or e-Transfer.";

/**
 * Stripe Customer for the payer, on the BRAND's account. Uses the same
 * (company, contact) mapping and the same idempotency key format as the deposit
 * checkout, so a customer who paid a deposit and then the invoice is one Stripe
 * Customer with one saved card, not two.
 */
async function ensureCustomer(db: Db, invoice: InvoiceRow, stripe: Stripe, acct: Stripe.RequestOptions): Promise<string> {
  const billTo = readBillTo(invoice.bill_to);
  if (invoice.contact_id) {
    const { data: existing } = await db
      .from("company_stripe_customers")
      .select("stripe_customer_id")
      .eq("company_id", invoice.company_id)
      .eq("contact_id", invoice.contact_id)
      .maybeSingle();
    if (existing?.stripe_customer_id) return existing.stripe_customer_id;
    const customer = await stripe.customers.create(
      {
        email: billTo.email ?? undefined,
        name: billTo.attention ?? billTo.name,
        metadata: { org_id: invoice.organization_id, company_id: invoice.company_id, contact_id: invoice.contact_id },
      },
      { ...acct, idempotencyKey: `quote-customer-${invoice.company_id}-${invoice.contact_id}` },
    );
    await db.from("company_stripe_customers").upsert(
      {
        company_id: invoice.company_id,
        organization_id: invoice.organization_id,
        contact_id: invoice.contact_id,
        stripe_customer_id: customer.id,
      },
      { onConflict: "company_id,contact_id", ignoreDuplicates: true },
    );
    const { data: settled } = await db
      .from("company_stripe_customers")
      .select("stripe_customer_id")
      .eq("company_id", invoice.company_id)
      .eq("contact_id", invoice.contact_id)
      .maybeSingle();
    return settled?.stripe_customer_id ?? customer.id;
  }
  // A business account with no contact on the invoice: a customer for this invoice.
  const solo = await stripe.customers.create(
    {
      email: billTo.email ?? undefined,
      name: billTo.name,
      metadata: { org_id: invoice.organization_id, company_id: invoice.company_id, customer_account_id: invoice.customer_account_id ?? "" },
    },
    { ...acct, idempotencyKey: `invoice-customer-${invoice.id}` },
  );
  return solo.id;
}

/**
 * Create the Checkout Session for an invoice's outstanding balance.
 *
 * DIRECT charge on the brand's connected account (company-stripe.ts) — funds land
 * in the brand's balance, never the platform's.
 *
 * No automatic_tax: unlike the deposit, this pays an INVOICE that already itemizes
 * HST. The invoice is the tax document; the charge is payment of its balance, so
 * Stripe must not compute (or add) tax again.
 *
 * Bank debit (Canadian PAD / ACSS) is asynchronous: Checkout completes with the
 * payment "processing", the money clears days later, and the webhook moves the
 * payment from pending to succeeded (or failed).
 */
export async function createInvoiceCheckout(token: string, method: OnlineMethod): Promise<{ url: string }> {
  const db = admin();
  const invoice = await invoiceByToken(db, token);
  if (!invoice) throw new InvoiceCheckoutError("Invoice not found.", "not_found");
  if (invoice.status === "void" || invoice.status === "paid") {
    throw new InvoiceCheckoutError("This invoice can't be paid online.", "not_payable");
  }
  const amount = invoice.balance_due_cents - invoice.pending_payment_cents;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new InvoiceCheckoutError(
      invoice.pending_payment_cents > 0 ? "A payment for this invoice is already processing." : "Nothing is owing on this invoice.",
      "nothing_owing",
    );
  }
  if (method === "bank_debit" && invoice.currency.toUpperCase() !== "CAD") {
    throw new InvoiceCheckoutError("Bank debit is only available for invoices in Canadian dollars.", "method_unavailable");
  }

  const company = await loadCompanyForInvoice(db, invoice.organization_id, invoice.company_id);
  const doc = buildInvoiceDocument(invoice, company);
  if (method === "bank_debit" && !doc.payment.bankDebit) {
    // Off in settings, or Stripe hasn't approved this brand's account for ACSS debits.
    throw new InvoiceCheckoutError(BANK_DEBIT_UNAVAILABLE_MESSAGE, "method_unavailable");
  }
  if (method === "card" && !doc.payment.card) {
    throw new InvoiceCheckoutError("That payment method isn't available for this invoice.", "method_unavailable");
  }

  const brand = await requireChargeableCompany(invoice.company_id);
  const stripe = getPlatformStripe();
  const acct = onAccount(brand);

  // Reuse an open session for the same method + amount (a double-tap, or a customer
  // who backed out and came back). Any other open session is expired first, so an
  // abandoned tab can never be paid on top of a newer one.
  const previousSessionId = invoice.stripe_checkout_session_id;
  if (previousSessionId) {
    let existing: Stripe.Checkout.Session | null = null;
    try {
      existing = await stripe.checkout.sessions.retrieve(previousSessionId, undefined, acct);
    } catch (err) {
      console.error(`[invoices] could not read session ${previousSessionId}:`, err instanceof Error ? err.message : err);
    }
    if (existing?.status === "open") {
      if (existing.url && existing.amount_total === amount && existing.metadata?.method === method) {
        return { url: existing.url };
      }
      await stripe.checkout.sessions.expire(existing.id, undefined, acct);
    } else if (existing?.status === "complete") {
      // The customer already paid (or authorized a debit) and the webhook hasn't
      // landed yet. Record it now rather than letting them start a second payment.
      const pi = intentId(existing);
      const { data: known } = pi
        ? await db.from("invoice_payments").select("id").eq("stripe_payment_intent_id", pi).maybeSingle()
        : { data: null };
      if (!known) {
        await handleInvoiceCheckoutCompleted(existing, "inline-reconcile", brand.accountId);
        throw new InvoiceCheckoutError("Your payment is already being processed — refresh this page in a moment.", "nothing_owing");
      }
    }
  }

  const customerId = await ensureCustomer(db, invoice, stripe, acct);
  const pageUrl = invoicePublicUrl(company, token);
  const meta = { org_id: invoice.organization_id, company_id: invoice.company_id, invoice_id: invoice.id, method };
  const isBusiness = Boolean(invoice.customer_account_id);

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId,
        payment_method_types: method === "card" ? ["card"] : ["acss_debit"],
        ...(method === "bank_debit"
          ? {
              payment_method_options: {
                acss_debit: {
                  // No `currency` here: Stripe only accepts it in setup mode; the
                  // currency comes from the line item.
                  mandate_options: {
                    payment_schedule: "sporadic",
                    transaction_type: isBusiness ? "business" : "personal",
                  },
                  verification_method: "automatic",
                },
              },
            }
          : {}),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: invoice.currency.toLowerCase(),
              unit_amount: amount,
              product_data: {
                name: `${doc.brand.name} — Invoice ${invoice.invoice_number ?? ""}`.trim(),
                description: invoice.title ?? undefined,
              },
            },
          },
        ],
        payment_intent_data: {
          description: `Invoice ${invoice.invoice_number ?? invoice.id}`,
          // The descriptor suffix is a card concept; bank debits use the account's own.
          ...(method === "card" && brand.statementDescriptorSuffix ? { statement_descriptor_suffix: brand.statementDescriptorSuffix } : {}),
          metadata: meta,
        },
        metadata: meta,
        client_reference_id: invoice.id,
        success_url: `${pageUrl}?paid=1`,
        cancel_url: pageUrl,
      },
      // Keyed to what is being paid AND to the attempt (the session it replaces): a
      // double-tap returns the same session, but switching method, retrying after a
      // bounced debit, or paying again after a refund always gets a fresh one —
      // never a replayed expired/completed session.
      { ...acct, idempotencyKey: `invoice-pay-${invoice.id}-${method}-${amount}-${invoice.amount_paid_cents}-${previousSessionId ?? "first"}` },
    );
  } catch (err) {
    // Our mirror of the account's capabilities can lag Stripe (a capability pulled,
    // a webhook not yet delivered). If Stripe refuses an ACSS debit, steer the
    // customer to another method instead of showing them an error page.
    if (method === "bank_debit") {
      console.error(`[invoices] bank debit checkout refused for invoice ${invoice.id}:`, err instanceof Error ? err.message : err);
      throw new InvoiceCheckoutError(BANK_DEBIT_UNAVAILABLE_MESSAGE, "method_unavailable");
    }
    throw err;
  }
  if (session.status !== "open" || !session.url) {
    throw new InvoiceCheckoutError("Couldn't start the payment — please try again.", "not_payable");
  }

  await db.from("invoices").update({ stripe_checkout_session_id: session.id }).eq("id", invoice.id);
  await recordInvoiceEvent(db, {
    organizationId: invoice.organization_id,
    invoiceId: invoice.id,
    eventType: "checkout_started",
    metadata: { method, amountCents: amount },
  });
  return { url: session.url ?? pageUrl };
}

// ── Webhook handlers (Stripe Connect) ────────────────────────────────────────

export interface WebhookOutcome {
  outcome: "applied" | "noop";
  invoiceId: string | null;
  reason?: string;
}

async function invoiceForEvent(db: Db, invoiceId: string | null | undefined, accountId: string): Promise<{ invoice: InvoiceRow } | { noop: WebhookOutcome }> {
  if (!invoiceId) return { noop: { outcome: "noop", invoiceId: null, reason: "no invoice_id in metadata" } };
  const { data: invoice } = await db.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  if (!invoice) return { noop: { outcome: "noop", invoiceId, reason: "invoice not found" } };
  // Cross-tenant guard: the connected account that sent the event must own the invoice.
  const { data: company } = await db
    .from("companies")
    .select("stripe_connected_account_id")
    .eq("id", invoice.company_id)
    .maybeSingle();
  if (company?.stripe_connected_account_id !== accountId) {
    return { noop: { outcome: "noop", invoiceId, reason: "event account does not match the invoice's tenant" } };
  }
  return { invoice };
}

function intentId(session: Stripe.Checkout.Session): string | null {
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
}

function methodOf(session: Stripe.Checkout.Session): "card" | "bank_debit" {
  if (session.metadata?.method === "bank_debit") return "bank_debit";
  return session.payment_method_types?.includes("acss_debit") && !session.payment_method_types.includes("card") ? "bank_debit" : "card";
}

/**
 * checkout.session.completed — card payments arrive here already paid; bank
 * debits arrive "unpaid" (processing) and are recorded as pending.
 *
 * Idempotent: the payment row is keyed by the PaymentIntent id (unique index), so
 * a redelivery finds the row and changes nothing.
 */
export async function handleInvoiceCheckoutCompleted(session: Stripe.Checkout.Session, eventId: string, accountId: string): Promise<WebhookOutcome> {
  const db = admin();
  const found = await invoiceForEvent(db, session.metadata?.invoice_id, accountId);
  if ("noop" in found) return found.noop;
  const { invoice } = found;

  const pi = intentId(session);
  if (!pi) return { outcome: "noop", invoiceId: invoice.id, reason: "session has no payment intent" };
  const amount = session.amount_total ?? 0;
  if (amount <= 0) return { outcome: "noop", invoiceId: invoice.id, reason: "zero amount" };

  const paid = session.payment_status === "paid";
  const { data: inserted, error } = await db
    .from("invoice_payments")
    .upsert(
      {
        organization_id: invoice.organization_id,
        company_id: invoice.company_id,
        invoice_id: invoice.id,
        amount_cents: amount,
        method: methodOf(session),
        status: paid ? "succeeded" : "pending",
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: pi,
        received_at: new Date().toISOString(),
      },
      { onConflict: "stripe_payment_intent_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!inserted) {
    // A retry after a partial failure: make sure the balance reflects the row.
    await refreshInvoiceBalance(db, invoice.id);
    return { outcome: "noop", invoiceId: invoice.id, reason: "payment already recorded" };
  }

  await refreshInvoiceBalance(db, invoice.id);
  await recordInvoiceEvent(db, {
    organizationId: invoice.organization_id,
    invoiceId: invoice.id,
    eventType: paid ? "payment_received" : "payment_processing",
    metadata: { eventId, amountCents: amount, method: methodOf(session) },
  });
  // A late payment against a void invoice is real money — flag it, don't hide it.
  if (invoice.status === "void") {
    await recordInvoiceEvent(db, { organizationId: invoice.organization_id, invoiceId: invoice.id, eventType: "payment_on_void_invoice", metadata: { eventId, amountCents: amount } });
  }
  await sendPaymentReceiptEmail(inserted.id);
  return { outcome: "applied", invoiceId: invoice.id };
}

/** checkout.session.async_payment_succeeded / _failed — a bank debit cleared or bounced. */
export async function handleInvoiceAsyncPayment(
  session: Stripe.Checkout.Session,
  eventId: string,
  accountId: string,
  result: "succeeded" | "failed",
): Promise<WebhookOutcome> {
  const db = admin();
  const found = await invoiceForEvent(db, session.metadata?.invoice_id, accountId);
  if ("noop" in found) return found.noop;
  const { invoice } = found;
  const pi = intentId(session);
  if (!pi) return { outcome: "noop", invoiceId: invoice.id, reason: "session has no payment intent" };

  // If .completed was missed, create the row now so nothing is lost.
  const { data: existing } = await db.from("invoice_payments").select("id, status").eq("stripe_payment_intent_id", pi).maybeSingle();
  let paymentId = existing?.id ?? null;
  if (!existing) {
    const { data: created, error } = await db
      .from("invoice_payments")
      .upsert(
        {
          organization_id: invoice.organization_id,
          company_id: invoice.company_id,
          invoice_id: invoice.id,
          amount_cents: session.amount_total ?? 0,
          method: methodOf(session),
          status: result,
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: pi,
          received_at: new Date().toISOString(),
          failure_reason: result === "failed" ? "The bank debit was declined or returned." : null,
        },
        { onConflict: "stripe_payment_intent_id", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (error) throw error;
    paymentId = created?.id ?? null;
  } else {
    if (existing.status !== "pending") {
      await refreshInvoiceBalance(db, invoice.id);
      return { outcome: "noop", invoiceId: invoice.id, reason: `payment already ${existing.status}` };
    }
    const { data: moved } = await db
      .from("invoice_payments")
      .update({
        status: result,
        ...(result === "failed" ? { failure_reason: "The bank debit was declined or returned." } : { received_at: new Date().toISOString() }),
      })
      .eq("id", existing.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!moved) {
      await refreshInvoiceBalance(db, invoice.id);
      return { outcome: "noop", invoiceId: invoice.id, reason: "already moved concurrently" };
    }
  }

  await refreshInvoiceBalance(db, invoice.id);
  await recordInvoiceEvent(db, {
    organizationId: invoice.organization_id,
    invoiceId: invoice.id,
    eventType: result === "succeeded" ? "payment_cleared" : "payment_failed",
    metadata: { eventId, amountCents: session.amount_total },
  });
  if (result === "succeeded" && paymentId) {
    await sendPaymentReceiptEmail(paymentId);
  } else if (result === "failed") {
    await emitInvoiceTrigger(db, {
      organizationId: invoice.organization_id,
      companyId: invoice.company_id,
      contactId: invoice.contact_id,
      invoiceId: invoice.id,
      quoteId: invoice.quote_id,
      eventType: "invoice.payment_failed",
      metadata: { amountCents: session.amount_total },
    });
  }
  return { outcome: "applied", invoiceId: invoice.id };
}

/**
 * charge.refunded — a refund issued in Stripe. A full refund turns the payment
 * into 'refunded' and the balance goes back up; a partial refund is logged for a
 * person to reconcile (the invoice keeps showing the gross payment).
 */
export async function handleInvoiceChargeRefunded(charge: Stripe.Charge, eventId: string, accountId: string): Promise<WebhookOutcome> {
  const db = admin();
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
  if (!pi) return { outcome: "noop", invoiceId: null, reason: "charge has no payment intent" };
  const { data: payment } = await db.from("invoice_payments").select("*").eq("stripe_payment_intent_id", pi).maybeSingle();
  if (!payment) return { outcome: "noop", invoiceId: null, reason: "not an invoice payment" };
  const found = await invoiceForEvent(db, payment.invoice_id, accountId);
  if ("noop" in found) return found.noop;

  const full = charge.amount_refunded >= payment.amount_cents;
  if (full && payment.status !== "refunded") {
    await db.from("invoice_payments").update({ status: "refunded" }).eq("id", payment.id);
    await refreshInvoiceBalance(db, payment.invoice_id);
  }
  await recordInvoiceEvent(db, {
    organizationId: payment.organization_id,
    invoiceId: payment.invoice_id,
    eventType: full ? "payment_refunded" : "payment_partially_refunded",
    metadata: { eventId, refundedCents: charge.amount_refunded, paymentCents: payment.amount_cents },
  });
  return { outcome: "applied", invoiceId: payment.invoice_id };
}

/**
 * payment_intent.payment_failed / payment_intent.canceled — a bank debit that never
 * completed (e.g. microdeposit verification abandoned, so Stripe cancels the
 * PaymentIntent without a Checkout async-failed event). Moves a PENDING invoice
 * payment to failed so the balance is payable again. Anything already settled is
 * left alone.
 */
export async function handleInvoicePaymentIntentFailed(intent: Stripe.PaymentIntent, eventId: string, accountId: string): Promise<WebhookOutcome> {
  const db = admin();
  const { data: payment } = await db.from("invoice_payments").select("*").eq("stripe_payment_intent_id", intent.id).maybeSingle();
  if (!payment) return { outcome: "noop", invoiceId: null, reason: "not an invoice payment" };
  const found = await invoiceForEvent(db, payment.invoice_id, accountId);
  if ("noop" in found) return found.noop;
  if (payment.status !== "pending") return { outcome: "noop", invoiceId: payment.invoice_id, reason: `payment already ${payment.status}` };

  const reason = intent.last_payment_error?.message ?? (intent.status === "canceled" ? "The bank debit was cancelled before it completed." : "The bank debit failed.");
  const { data: moved } = await db
    .from("invoice_payments")
    .update({ status: "failed", failure_reason: reason })
    .eq("id", payment.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  await refreshInvoiceBalance(db, payment.invoice_id);
  if (!moved) return { outcome: "noop", invoiceId: payment.invoice_id, reason: "already moved concurrently" };

  await recordInvoiceEvent(db, { organizationId: payment.organization_id, invoiceId: payment.invoice_id, eventType: "payment_failed", metadata: { eventId, reason } });
  const invoice = found.invoice;
  await emitInvoiceTrigger(db, {
    organizationId: invoice.organization_id,
    companyId: invoice.company_id,
    contactId: invoice.contact_id,
    invoiceId: invoice.id,
    quoteId: invoice.quote_id,
    eventType: "invoice.payment_failed",
    metadata: { amountCents: payment.amount_cents },
  });
  return { outcome: "applied", invoiceId: payment.invoice_id };
}

/**
 * Expire the invoice's open Checkout session, if any — called when staff change
 * what's owed (edit, record a payment, void), so a tab the customer left open
 * can't be paid for the old amount. Best-effort and never throws: the staff action
 * has already happened, and the pay page re-validates the amount on every attempt.
 */
export async function expireOpenInvoiceCheckout(invoiceId: string): Promise<void> {
  try {
    const db = admin();
    const { data: invoice } = await db
      .from("invoices")
      .select("company_id, stripe_checkout_session_id")
      .eq("id", invoiceId)
      .maybeSingle();
    if (!invoice?.stripe_checkout_session_id) return;
    const brand = await getCompanyStripeConfig(invoice.company_id);
    const stripe = getPlatformStripe();
    const acct = onAccount(brand);
    const session = await stripe.checkout.sessions.retrieve(invoice.stripe_checkout_session_id, undefined, acct);
    if (session.status === "open") await stripe.checkout.sessions.expire(session.id, undefined, acct);
  } catch (err) {
    console.error(`[invoices] could not expire checkout for ${invoiceId}:`, err instanceof Error ? err.message : err);
  }
}
