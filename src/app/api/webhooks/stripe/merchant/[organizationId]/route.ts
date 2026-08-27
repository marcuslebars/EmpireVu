/**
 * Merchant webhook — one endpoint per org, for the org's OWN Stripe account.
 *
 * Each tenant's Stripe account is configured to post here with its own
 * organization id in the path. That matters for verification: the org is known
 * from the URL BEFORE the signature is checked, so we verify against exactly one
 * secret — that org's. There is no guessing, no trying-each-secret-in-turn, and
 * one org's signing secret can never validate another org's payload.
 *
 * The platform endpoint (/api/webhooks/stripe) is unrelated and stays as it is:
 * it serves Tilotto's own account billing orgs for their subscriptions.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { handleDepositCheckoutCompleted } from "@/server/services/quotes/checkout";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { getOrgStripeClient, getOrgWebhookSecret, OrgStripeError } from "@/server/services/quotes/org-stripe";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const organizationId = context.params.organizationId;

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
      getOrgStripeClient(organizationId),
      getOrgWebhookSecret(organizationId),
    ]);
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    if (err instanceof OrgStripeError) {
      // Misconfiguration, not a bad request: 500 so Stripe retries once the
      // operator sets the missing var, rather than silently dropping a payment.
      console.error(`[quotes/webhook] org ${organizationId} Stripe config error (${err.code}):`, err.message);
      return NextResponse.json({ error: "Merchant Stripe is not configured." }, { status: 500 });
    }
    // Never log the payload or the signature — a failed verification is exactly
    // the case where the body may be hostile.
    console.error(
      `[quotes/webhook] signature verification failed for org ${organizationId}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // Cross-tenant guard: the session's metadata must name THIS org. Signature
      // verification already proves the event came from this org's account, so
      // this is defence in depth against a mis-copied endpoint URL.
      if (session.metadata?.org_id && session.metadata.org_id !== organizationId) {
        console.error(
          `[quotes/webhook] ${event.id} org mismatch: path=${organizationId} metadata=${session.metadata.org_id}`,
        );
        return NextResponse.json({ error: "Organization mismatch." }, { status: 400 });
      }

      if (session.metadata?.quote_id) {
        const result = await handleDepositCheckoutCompleted(session, event.id);
        console.log(
          `[quotes/webhook] ${event.id} org=${organizationId} quote=${result.quoteId} outcome=${result.outcome}` +
            (result.reason ? ` reason=${result.reason}` : ""),
        );
      }
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    // 500 so Stripe retries. The handler is idempotent on deposit_paid_at, so a
    // retry after a partial failure cannot double-apply.
    console.error(
      `[quotes/webhook] failed to handle ${event.id} for org ${organizationId}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Could not handle the event." }, { status: 500 });
  }
}
