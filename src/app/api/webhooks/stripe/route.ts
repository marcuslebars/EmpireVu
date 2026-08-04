import { NextResponse } from "next/server";

import { recordBillingEvent } from "@/server/services/billing/events";
import { getStripeClient } from "@/server/services/billing/stripe";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook. Public (the middleware matcher excludes /api/*), authenticated
 * by Stripe's signature over the RAW request body — mirrors the HMAC lead-intake
 * route's ordering:
 *
 *   verify signature  -> bad/missing => 4xx, and NO write happens
 *   durable-write-first (record_billing_event: ledger + enqueue, atomic + idempotent)
 *   return 200 fast    -> processing happens later on the billing worker
 *
 * A duplicate delivery is a no-op (unique stripe_event_id) and still returns 200.
 * Only a durable-write failure returns 500, so Stripe retries the delivery.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  // Server-only secrets. Missing config -> 503 (same shape as the intake route).
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("[billing/webhook] Stripe env not configured — rejecting");
    return NextResponse.json({ error: "Billing webhook not configured." }, { status: 503 });
  }

  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
  }

  // Verify over the exact bytes. A bad signature is rejected before any write.
  let event;
  try {
    event = getStripeClient().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error(
      "[billing/webhook] signature verification failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    await recordBillingEvent(supabase, event);
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    // Only the durable write failing reaches here -> 500 so Stripe retries.
    console.error(
      "[billing/webhook] failed to record event:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Could not record the event." }, { status: 500 });
  }
}
