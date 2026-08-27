/**
 * Merchant webhook — one endpoint per BRAND (company), for that brand's Stripe
 * account.
 *
 * The company id is in the path, so the brand is known BEFORE the signature is
 * checked and exactly one secret is tried — that brand's. No guessing, no
 * try-each-secret loop, and one brand's signing secret can never validate
 * another's payload.
 *
 * Brands that share a Stripe account (the A1 group companies do) share its
 * signing secret too, so they may point at any one of their endpoints — the
 * metadata cross-check below is what keeps the routing honest in that case.
 *
 * The platform endpoint (/api/webhooks/stripe) is unrelated and stays as it is:
 * it serves Tilotto's own account billing orgs for their subscriptions.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { handleDepositCheckoutCompleted } from "@/server/services/quotes/checkout";
import {
  CompanyStripeError,
  getCompanyStripeClient,
  getCompanyWebhookSecret,
} from "@/server/services/quotes/company-stripe";
import { getQuotesConfig } from "@/server/services/quotes/config";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { companyId: string };
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const companyId = context.params.companyId;

  if (!getQuotesConfig().enabled) {
    return NextResponse.json({ error: "Quotes are not enabled." }, { status: 404 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }

  // Raw body — constructEvent must see the exact bytes Stripe signed.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    const [stripe, secret] = await Promise.all([
      getCompanyStripeClient(companyId),
      getCompanyWebhookSecret(companyId),
    ]);
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    if (err instanceof CompanyStripeError) {
      // Misconfiguration, not a bad request: 500 so Stripe RETRIES once the
      // operator sets the missing var, rather than silently dropping a payment.
      console.error(`[quotes/webhook] company ${companyId} Stripe config error (${err.code}):`, err.message);
      return NextResponse.json({ error: "Merchant Stripe is not configured." }, { status: 500 });
    }
    // Never log the payload or the signature — a failed verification is exactly
    // the case where the body may be hostile.
    console.error(
      `[quotes/webhook] signature verification failed for company ${companyId}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // Cross-brand guard. Signature verification proves the event came from the
      // ACCOUNT — but sibling brands share that account, so it does NOT prove the
      // event belongs to this brand. The metadata is what distinguishes them.
      if (session.metadata?.company_id && session.metadata.company_id !== companyId) {
        console.error(
          `[quotes/webhook] ${event.id} company mismatch: path=${companyId} metadata=${session.metadata.company_id}`,
        );
        return NextResponse.json({ error: "Company mismatch." }, { status: 400 });
      }

      if (session.metadata?.quote_id) {
        const result = await handleDepositCheckoutCompleted(session, event.id);
        console.log(
          `[quotes/webhook] ${event.id} company=${companyId} quote=${result.quoteId} outcome=${result.outcome}` +
            (result.reason ? ` reason=${result.reason}` : ""),
        );
      }
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    // 500 so Stripe retries. The handler is idempotent on deposit_paid_at, so a
    // retry after a partial failure cannot double-apply.
    console.error(
      `[quotes/webhook] failed to handle ${event.id} for company ${companyId}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Could not handle the event." }, { status: 500 });
  }
}
