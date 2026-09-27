/**
 * Deposit Checkout — turns an approved quote into a Stripe Checkout Session.
 *
 * Charges are DIRECT charges on the tenant's CONNECTED Stripe account (see
 * company-stripe.ts): the platform key plus a Stripe-Account header. Funds land
 * in the tenant's balance, refunds hit their account, and their statement
 * descriptor and tax registration apply — the customer never sees the platform.
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
 *    total (or a fixed amount taken against it), so the amount we charge already contains the HST. Declaring it
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
import { getPlatformStripe, onAccount, requireChargeableCompany } from "./company-stripe";
import { sendDepositReceiptEmail } from "./notify";
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
    readonly code: "not_approved" | "already_paid" | "no_amount" | "no_contact" | "no_company",
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
/**
 * Find-or-create the Stripe Customer for a contact, SCOPED TO THE MERCHANT
 * ACCOUNT.
 *
 * Stripe Customers belong to one account, so the mapping is keyed by
 * (company_id, contact_id): the same contact quoted by two brands on two
 * accounts legitimately holds two different customer ids, and neither collides.
 *
 * This is also why the mapping is not kept on the quote. It used to be, and that
 * meant a repeat customer got a brand-new Stripe Customer for every quote —
 * scattering their saved cards across duplicates. Phase 4 charges the balance
 * off-session against the saved card, so a fresh customer per quote would have
 * left nothing to charge.
 *
 * The insert is upserted and then re-read, so two concurrent checkouts converge
 * on one customer rather than racing to create two.
 */
async function ensureContactCustomer(
  quote: Db,
  stripe: Stripe,
  acct: Stripe.RequestOptions,
): Promise<string> {
  const db = createSupabaseAdminClient() as Db;

  if (!quote.contact_id) {
    // No contact to key on: create an unmapped customer for this quote only.
    const solo = await stripe.customers.create(
      {
        name: quote.approved_by_name ?? undefined,
        metadata: { org_id: quote.organization_id, company_id: quote.company_id, quote_id: quote.id },
      },
      { ...acct, idempotencyKey: `quote-customer-${quote.id}` },
    );
    return solo.id;
  }

  const { data: existing } = await db
    .from("company_stripe_customers")
    .select("stripe_customer_id")
    .eq("company_id", quote.company_id)
    .eq("contact_id", quote.contact_id)
    .maybeSingle();
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const { data: contact } = await db
    .from("contacts")
    .select("email, first_name, last_name")
    .eq("id", quote.contact_id)
    .maybeSingle();

  const email = contact?.email ?? null;
  const name = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null : null;

  const customer = await stripe.customers.create(
    {
      email: email ?? undefined,
      name: name ?? quote.approved_by_name ?? undefined,
      metadata: {
        org_id: quote.organization_id,
        company_id: quote.company_id,
        contact_id: quote.contact_id,
      },
    },
    // Keyed by company+contact so a retry cannot mint a duplicate on the account.
    // Customers live on the CONNECTED account, which is why the mapping is
    // company-scoped: the same contact under two tenants is two Stripe Customers.
    { ...acct, idempotencyKey: `quote-customer-${quote.company_id}-${quote.contact_id}` },
  );

  const { error } = await db.from("company_stripe_customers").upsert(
    {
      company_id: quote.company_id,
      organization_id: quote.organization_id,
      contact_id: quote.contact_id,
      stripe_customer_id: customer.id,
    },
    { onConflict: "company_id,contact_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error(`[quotes] failed to persist customer mapping for contact ${quote.contact_id}:`, error);
  }

  // Re-read: if a concurrent checkout won the upsert, use THEIR customer so both
  // requests converge on one.
  const { data: settled } = await db
    .from("company_stripe_customers")
    .select("stripe_customer_id")
    .eq("company_id", quote.company_id)
    .eq("contact_id", quote.contact_id)
    .maybeSingle();

  return settled?.stripe_customer_id ?? customer.id;
}

function depositDescription(quote: Db): string {
  const ref = quote.quote_number ? ` (${quote.quote_number})` : "";
  // A fixed deposit is not "25%" of anything — naming a percentage the customer
  // can't reconcile against the quote is how disputes start.
  if (quote.deposit_flat_cents) return `Booking deposit — comes off the final invoice${ref}`;
  const pct = Math.round((quote.deposit_rate_bps ?? 2500) / 100);
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

  // The BRAND's own Stripe account — never the platform account, and never
  // another brand's. A deposit landing in EmpireVu's account, or in Marine Care's
  // instead of Storage's, would be a real mess to unwind.
  if (!quote.company_id) {
    throw new DepositCheckoutError(
      "Quote has no company, so no merchant Stripe account can be resolved.",
      "no_company",
    );
  }
  // requireChargeableCompany, not just "configured": Stripe onboarding can finish
  // while charges_enabled is still false pending verification, and finding that
  // out when a customer taps Pay is the worst possible moment.
  const brand = await requireChargeableCompany(quote.company_id);
  const stripe = getPlatformStripe();
  // Every call below is DIRECT: created on the tenant's account, so funds land in
  // their balance and their descriptor and tax registration apply. Omitting these
  // options would charge into the PLATFORM account instead.
  const acct = onAccount(brand);

  // Reuse an open session rather than minting a second one.
  if (quote.stripe_checkout_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(quote.stripe_checkout_session_id, undefined, acct);
      if (existing.status === "open" && existing.url) {
        return { url: existing.url, sessionId: existing.id, reused: true };
      }
    } catch (err) {
      // Session vanished or is unreadable — fall through and create a fresh one.
      console.error(`[quotes] could not retrieve session ${quote.stripe_checkout_session_id}:`, err);
    }
  }

  const customerId = await ensureContactCustomer(quote, stripe, acct);
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
              // Brand-first so the Checkout page, the Stripe receipt and the
              // dashboard all name the brand, not just "Booking deposit".
              name: brand.name ? `${brand.name} — ${quote.title || "Booking deposit"}` : quote.title || "Booking deposit",
              description: depositDescription(quote),
            },
          },
        },
      ],
      payment_intent_data: {
        // Save the card so Phase 4 can charge the balance off-session.
        setup_future_usage: "off_session",
        // The A1 brands share one Stripe account, so this suffix is what tells a
        // cardholder WHICH brand charged them. Omitted (account default applies)
        // rather than sent malformed — Stripe rejects the charge outright if the
        // descriptor is invalid, and a bad brand name must not fail a payment.
        ...(brand.statementDescriptorSuffix
          ? { statement_descriptor_suffix: brand.statementDescriptorSuffix }
          : {}),
        metadata: { org_id: quote.organization_id, company_id: quote.company_id, quote_id: quote.id },
      },
      metadata: { org_id: quote.organization_id, company_id: quote.company_id, quote_id: quote.id },
      client_reference_id: quote.id,
      // Both land back on the quote page. Success renders the confirmation state;
      // cancel returns to the live quote with the approval still standing, so a
      // customer who bailed at the card screen can simply pay again.
      success_url: `${quoteUrl}?paid=1`,
      cancel_url: `${quoteUrl}?cancelled=1`,
    },
    // Keyed by quote + amount: a retry returns the same session, but a reissued
    // amount legitimately creates a new one.
    { ...acct, idempotencyKey: `quote-deposit-${quote.id}-${amount}` },
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
  accountId?: string,
): Promise<{ outcome: "applied" | "noop"; quoteId: string | null; reason?: string }> {
  const quoteId = session.metadata?.quote_id ?? null;
  if (!quoteId) return { outcome: "noop", quoteId: null, reason: "no quote_id in metadata" };

  const db = createSupabaseAdminClient() as Db;
  const { data: quote } = await db.from("quotes").select("*").eq("id", quoteId).maybeSingle();
  if (!quote) return { outcome: "noop", quoteId, reason: "quote not found" };

  // Cross-tenant guard. The signature proves Stripe sent the event and
  // event.account names the connected account it came from; this checks that the
  // quote actually belongs to that tenant. Without it, a quote id from one tenant
  // arriving on another's event would be applied.
  if (accountId) {
    const { data: company } = await db
      .from("companies")
      .select("stripe_connected_account_id")
      .eq("id", quote.company_id)
      .maybeSingle();
    if (company?.stripe_connected_account_id !== accountId) {
      return { outcome: "noop", quoteId, reason: "event account does not match the quote's tenant" };
    }
  }

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

  // Best-effort by design. The money has landed and the state is correct; a mail
  // failure must not make this throw, because the webhook would then 500 and
  // Stripe would retry an event that is already fully applied.
  await sendDepositReceiptEmail(quoteId);

  return { outcome: "applied", quoteId };
}
