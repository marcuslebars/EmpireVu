/**
 * Deposit Checkout — turns an approved quote into a Stripe Checkout Session.
 *
 * Charges run on the ORG'S OWN Stripe account, resolved per org (see
 * org-stripe.ts) — not the platform account that Phase 1 billing uses. The API
 * version pin is shared with billing; nothing else is.
 *
 * Two details that are easy to get wrong and that the "displayed == charged"
 * requirement depends on:
 *
 * 1. `setup_future_usage` is NOT a top-level Checkout Session parameter. In
 *    payment mode it lives at `payment_intent_data.setup_future_usage`. Setting
 *    it to 'off_session' attaches the card to the Customer so Phase 4 can charge
 *    the balance without the customer present.
 *
 * 2. `tax_behavior` must be 'inclusive'. Our deposit is 25% of the TAX-INCLUSIVE
 *    total, so the amount we charge already contains the HST. Declaring it
 *    'exclusive' would make Stripe Tax add HST a second time, and the customer
 *    would be charged more than the page showed. With 'inclusive', Stripe
 *    back-computes the tax within the amount and the charged total equals
 *    deposit_cents exactly.
 *
 * The amount always comes from the FROZEN approved_deposit_cents — never from a
 * request body, and never recomputed here.
 */
import type Stripe from "stripe";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { getOrgStripeClient } from "./org-stripe";
import { recordPublicEvent } from "./public-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface DepositCheckoutResult {
  url: string;
  sessionId: string;
  /** True when an existing open session was reused rather than a new one created. */
  reused: boolean;
}

export class DepositCheckoutError extends Error {
  constructor(
    message: string,
    readonly code: "not_approved" | "already_paid" | "no_amount" | "no_contact",
  ) {
    super(message);
    this.name = "DepositCheckoutError";
  }
}

/**
 * Find-or-create the Stripe Customer for the CONTACT (not the org — the org is the
 * tenant, the contact is the payer). Persisted on the quote so a crash mid-flow
 * never loses the mapping, and keyed with an idempotency key so a retry cannot
 * create a duplicate customer.
 */
async function ensureContactCustomer(quote: Db, stripe: Stripe): Promise<string> {
  if (quote.stripe_customer_id) return quote.stripe_customer_id;

  const db = createSupabaseAdminClient() as Db;
  let email: string | null = null;
  let name: string | null = null;

  if (quote.contact_id) {
    const { data: contact } = await db
      .from("contacts")
      .select("email, first_name, last_name")
      .eq("id", quote.contact_id)
      .maybeSingle();
    if (contact) {
      email = contact.email ?? null;
      name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null;
    }
  }

  const customer = await stripe.customers.create(
    {
      email: email ?? undefined,
      name: name ?? quote.approved_by_name ?? undefined,
      metadata: { org_id: quote.organization_id, quote_id: quote.id },
    },
    { idempotencyKey: `quote-customer-${quote.id}` },
  );

  const { error } = await db
    .from("quotes")
    .update({ stripe_customer_id: customer.id })
    .eq("id", quote.id);
  if (error) {
    console.error(`[quotes] created Stripe customer ${customer.id} but failed to persist it:`, error);
  }

  return customer.id;
}

function depositDescription(quote: Db): string {
  const pct = Math.round((quote.deposit_rate_bps ?? 2500) / 100);
  const ref = quote.quote_number ? ` (${quote.quote_number})` : "";
  return `${pct}% booking deposit${ref}`;
}

/**
 * Create (or reuse) the deposit Checkout Session for an approved quote.
 *
 * Idempotent on the quote: if an open session already exists we return it, so a
 * double-tap on Approve — or a customer who bailed at the card screen and came
 * back — gets the same session rather than a second one. A session that Stripe
 * has expired is replaced.
 */
export async function createDepositCheckoutSession(
  token: string,
  opts: { baseUrl: string },
): Promise<DepositCheckoutResult> {
  const db = createSupabaseAdminClient() as Db;
  const { data: quote, error } = await db
    .from("quotes")
    .select("*")
    .eq("public_token", token)
    .maybeSingle();
  if (error) throw error;
  if (!quote) throw new DepositCheckoutError("Quote not found.", "not_approved");

  if (quote.deposit_paid_at) {
    throw new DepositCheckoutError("This deposit has already been paid.", "already_paid");
  }
  if (!quote.approved_at) {
    throw new DepositCheckoutError("Quote must be approved before checkout.", "not_approved");
  }

  const amount = quote.approved_deposit_cents;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new DepositCheckoutError("Quote has no deposit amount to charge.", "no_amount");
  }

  // The org's OWN Stripe account — never the platform account. A deposit landing
  // in Tilotto's account instead of the tenant's would be a real mess to unwind.
  const stripe = await getOrgStripeClient(quote.organization_id);

  // Reuse an open session rather than minting a second one.
  if (quote.stripe_checkout_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(quote.stripe_checkout_session_id);
      if (existing.status === "open" && existing.url) {
        return { url: existing.url, sessionId: existing.id, reused: true };
      }
    } catch (err) {
      // Session vanished or is unreadable — fall through and create a fresh one.
      console.error(`[quotes] could not retrieve session ${quote.stripe_checkout_session_id}:`, err);
    }
  }

  const customerId = await ensureContactCustomer(quote, stripe);
  const quoteUrl = `${opts.baseUrl.replace(/\/$/, "")}/q/${token}`;

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer: customerId,
      // automatic_tax with a supplied customer requires Checkout to be allowed to
      // write the address it collects back to the Customer.
      customer_update: { address: "auto" },
      automatic_tax: { enabled: true },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: (quote.currency ?? "CAD").toLowerCase(),
            unit_amount: amount,
            // See the header note: the deposit already contains HST.
            tax_behavior: "inclusive",
            product_data: {
              name: quote.title || "Booking deposit",
              description: depositDescription(quote),
            },
          },
        },
      ],
      payment_intent_data: {
        // Save the card so Phase 4 can charge the balance off-session.
        setup_future_usage: "off_session",
        metadata: { org_id: quote.organization_id, quote_id: quote.id },
      },
      metadata: { org_id: quote.organization_id, quote_id: quote.id },
      client_reference_id: quote.id,
      // Both land back on the quote page. Success renders the confirmation state;
      // cancel returns to the live quote with the approval still standing, so a
      // customer who bailed at the card screen can simply pay again.
      success_url: `${quoteUrl}?paid=1`,
      cancel_url: `${quoteUrl}?cancelled=1`,
    },
    // Keyed by quote + amount: a retry returns the same session, but a reissued
    // amount legitimately creates a new one.
    { idempotencyKey: `quote-deposit-${quote.id}-${amount}` },
  );

  await db
    .from("quotes")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", quote.id);

  await recordPublicEvent(quote.organization_id, quote.id, "checkout_session_created", {
    sessionId: session.id,
    amountCents: amount,
  });

  return { url: session.url ?? quoteUrl, sessionId: session.id, reused: false };
}

/**
 * Handle checkout.session.completed for a quote deposit.
 *
 * Idempotent on (event id, quote id): the guard is the UPDATE's WHERE clause —
 * only a row whose deposit_paid_at is still null is written, so a redelivered
 * event is a no-op rather than a second state change or a second email.
 *
 * Returns what happened so the caller can log it without re-deriving it.
 */
export async function handleDepositCheckoutCompleted(
  session: Stripe.Checkout.Session,
  eventId: string,
): Promise<{ outcome: "applied" | "noop"; quoteId: string | null; reason?: string }> {
  const quoteId = session.metadata?.quote_id ?? null;
  if (!quoteId) return { outcome: "noop", quoteId: null, reason: "no quote_id in metadata" };

  const db = createSupabaseAdminClient() as Db;
  const { data: quote } = await db.from("quotes").select("*").eq("id", quoteId).maybeSingle();
  if (!quote) return { outcome: "noop", quoteId, reason: "quote not found" };

  if (quote.deposit_paid_at) {
    return { outcome: "noop", quoteId, reason: "deposit already recorded" };
  }
  // A quote replaced (or cancelled) between checkout and webhook: record nothing
  // and let a human sort out the refund. Never resurrect it into deposit_paid.
  if (quote.superseded_by || quote.status === "cancelled") {
    return { outcome: "noop", quoteId, reason: "quote was superseded or cancelled" };
  }

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;

  const { data: updated } = await db
    .from("quotes")
    .update({
      status: "deposit_paid",
      deposit_paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
      stripe_customer_id: customerId ?? quote.stripe_customer_id,
      stripe_checkout_session_id: session.id,
    })
    .eq("id", quoteId)
    .is("deposit_paid_at", null) // the idempotency guard
    .select("*")
    .maybeSingle();

  if (!updated) return { outcome: "noop", quoteId, reason: "already applied concurrently" };

  await recordPublicEvent(updated.organization_id, quoteId, "deposit_paid", {
    eventId,
    sessionId: session.id,
    amountTotal: session.amount_total,
    paymentIntentId,
  });

  return { outcome: "applied", quoteId };
}
