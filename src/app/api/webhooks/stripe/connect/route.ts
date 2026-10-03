/**
 * Connect webhook — ONE endpoint for every tenant.
 *
 * This replaces the per-company endpoint the env-var scheme needed. Stripe
 * delivers events from all connected accounts to a single platform endpoint,
 * stamped with `event.account`, so there is nothing to register per tenant and
 * one signing secret to rotate instead of N.
 *
 * Register it in the platform Stripe dashboard with "listen to events on
 * connected accounts"; its signing secret is STRIPE_CONNECT_WEBHOOK_SECRET,
 * distinct from the platform-own endpoint's secret.
 *
 * Verification happens against that one secret BEFORE any payload field is read.
 * `event.account` is then trusted only because the signature already proved
 * Stripe sent it.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";

import {
  handleInvoiceAsyncPayment,
  handleInvoiceChargeRefunded,
  handleInvoiceCheckoutCompleted,
  handleInvoicePaymentIntentFailed,
  type WebhookOutcome,
} from "@/server/services/invoices/public";
import { handleDepositCheckoutCompleted } from "@/server/services/quotes/checkout";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { getPlatformStripe } from "@/server/services/quotes/company-stripe";
import { syncConnectedAccountState } from "@/server/services/quotes/connect";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const backstop = await enforceWebhookBackstop(request, "stripe_connect_webhook");
  if (backstop) return backstop;

  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfiguration, not a bad request: 500 so Stripe RETRIES once the
    // operator sets it, rather than silently dropping a real payment.
    console.error("[connect/webhook] STRIPE_CONNECT_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Not configured." }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  // Raw body — constructEvent must see the exact bytes Stripe signed.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = getPlatformStripe().webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    // Never log the payload or signature — a failed verification is exactly when
    // the body may be hostile.
    console.error(
      "[connect/webhook] signature verification failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  // Every Connect event carries the account it came from. Without one this is a
  // platform-own event that reached the wrong endpoint.
  const accountId = event.account;
  if (!accountId) {
    console.warn(`[connect/webhook] ${event.id} (${event.type}) has no account; ignoring`);
    return NextResponse.json({ received: true }, { status: 200 });
  }

  try {
    switch (event.type) {
      case "account.updated": {
        // Capability changes: charges_enabled flipping true is what makes a
        // tenant able to trade. Handled even when quotes are disabled, so
        // onboarding state stays accurate before the feature is switched on.
        await syncConnectedAccountState(event.data.object as Stripe.Account);
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // Invoice payments (card: paid now; bank debit: processing → pending row).
        if (session.metadata?.invoice_id) {
          logInvoice(event, accountId, await handleInvoiceCheckoutCompleted(session, event.id, accountId));
          break;
        }
        if (!getQuotesConfig().enabled) break;
        if (!session.metadata?.quote_id) break;

        const result = await handleDepositCheckoutCompleted(session, event.id, accountId);
        console.log(
          `[connect/webhook] ${event.id} account=${accountId} quote=${result.quoteId} ` +
            `outcome=${result.outcome}${result.reason ? ` reason=${result.reason}` : ""}`,
        );
        break;
      }

      // A Canadian pre-authorized debit cleared (or bounced) days after checkout.
      // The Connect endpoint must be subscribed to these two events in Stripe.
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (!session.metadata?.invoice_id) break;
        const result = event.type === "checkout.session.async_payment_succeeded" ? "succeeded" : "failed";
        logInvoice(event, accountId, await handleInvoiceAsyncPayment(session, event.id, accountId, result));
        break;
      }

      // A refund issued in the brand's Stripe dashboard against an invoice payment.
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        logInvoice(event, accountId, await handleInvoiceChargeRefunded(charge, event.id, accountId));
        break;
      }

      // A bank debit whose PaymentIntent failed or was cancelled (e.g. microdeposit
      // verification never completed) — frees the balance to be paid again.
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        const intent = event.data.object as Stripe.PaymentIntent;
        if (!intent.metadata?.invoice_id) break;
        logInvoice(event, accountId, await handleInvoicePaymentIntentFailed(intent, event.id, accountId));
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    // 500 so Stripe retries. The deposit handler is idempotent on
    // deposit_paid_at, so a retry after a partial failure cannot double-apply.
    console.error(
      `[connect/webhook] failed to handle ${event.id} (${event.type}):`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Could not handle the event." }, { status: 500 });
  }
}

function logInvoice(event: Stripe.Event, accountId: string, result: WebhookOutcome): void {
  console.log(
    `[connect/webhook] ${event.id} (${event.type}) account=${accountId} invoice=${result.invoiceId} ` +
      `outcome=${result.outcome}${result.reason ? ` reason=${result.reason}` : ""}`,
  );
}
