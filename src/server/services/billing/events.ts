import type Stripe from "stripe";

import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

/**
 * Best-effort extraction of the Stripe customer id from an event's object. Used
 * only to pre-resolve the ledger row to an org where cheap; the processor
 * resolves again at process time, so returning null here is fine.
 */
export function stripeCustomerIdFromEvent(event: Stripe.Event): string | null {
  const object = event.data?.object as unknown as Record<string, unknown> | undefined;
  const customer = object?.customer;

  if (typeof customer === "string") {
    return customer;
  }
  if (customer && typeof customer === "object" && "id" in customer) {
    const id = (customer as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/**
 * Durable-write-first: persist the raw Stripe event to the billing_events ledger
 * AND enqueue a processing job, atomically and idempotently, via the
 * record_billing_event RPC (insert-on-conflict-do-nothing + enqueue in one
 * transaction). Returns the new ledger row id, or null if this event id was
 * already received (a duplicate delivery — the webhook still returns 200).
 */
export async function recordBillingEvent(
  supabase: AdminSupabaseClient,
  event: Stripe.Event,
): Promise<string | null> {
  // RPCs aren't in the generated Database types (Functions is empty), so we cast
  // the client for the call — same convention as claim_workflow_event_jobs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await ((supabase as any).rpc("record_billing_event", {
    p_organization_id: null,
    p_payload: event,
    p_stripe_event_id: event.id,
    p_type: event.type,
  }) as Promise<{ data: string | null; error: { message: string } | null }>);

  if (error) {
    throw new Error(`record_billing_event failed: ${error.message}`);
  }

  return data ?? null;
}
