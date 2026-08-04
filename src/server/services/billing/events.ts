import type Stripe from "stripe";

import type { Tables } from "@/server/db/database.types";
import { isBillingPlan, type SubscriptionStatus } from "@/server/services/billing/config";
import { planForStripePriceId } from "@/server/services/billing/env";
import {
  completeBillingEventJob,
  failBillingEventJob,
} from "@/server/services/billing/jobs";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

// Stripe event objects are a 70+ member discriminated union; we read a handful of
// fields defensively rather than narrow every variant.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeEventObject = Record<string, any>;

/** Event types whose state transitions this processor applies. */
const HANDLED_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/**
 * A handled event referenced a Stripe customer we can't map to an organization.
 * The processor treats this as terminal-for-now: the ledger row is kept
 * (never discarded), the job dead-letters, and it is surfaced loudly in logs for
 * manual review (e.g. re-drive once the customer is linked).
 */
export class UnresolvedCustomerError extends Error {
  constructor(customerId: string | null, eventType: string) {
    super(
      `No organization for Stripe customer ${customerId ?? "(none)"} on ${eventType}.`,
    );
    this.name = "UnresolvedCustomerError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Map a Stripe subscription status onto our reduced, DB-constrained set. */
export function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      return "none";
    default:
      return "past_due";
  }
}

/**
 * Best-effort extraction of the Stripe customer id from an event's object. Used
 * only to pre-resolve the ledger row to an org where cheap; the processor
 * resolves again at process time, so returning null here is fine.
 */
export function stripeCustomerIdFromEvent(event: Stripe.Event): string | null {
  return customerIdOf(event.data?.object as unknown as StripeEventObject | undefined);
}

function customerIdOf(object: StripeEventObject | undefined): string | null {
  const customer = object?.customer;
  if (typeof customer === "string") {
    return customer;
  }
  if (customer && typeof customer === "object" && typeof customer.id === "string") {
    return customer.id;
  }
  return null;
}

/** invoice.subscription moved under parent.subscription_details in recent API versions. */
function invoiceSubscriptionId(object: StripeEventObject): string | null {
  const direct = object.subscription;
  if (typeof direct === "string") {
    return direct;
  }
  const nested = object.parent?.subscription_details?.subscription;
  return typeof nested === "string" ? nested : null;
}

function unixToIso(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
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

// ── org + subscription writes (service-role, RLS-bypassing) ──────────────────

async function resolveOrgByCustomer(
  supabase: AdminSupabaseClient,
  customerId: string | null,
): Promise<Tables<"organizations"> | null> {
  if (!customerId) {
    return null;
  }
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return (data as Tables<"organizations"> | null) ?? null;
}

async function updateOrganization(
  supabase: AdminSupabaseClient,
  organizationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("organizations") as any).update(patch).eq("id", organizationId);
  if (error) {
    throw error;
  }
}

/**
 * Upsert the subscriptions mirror keyed on stripe_subscription_id — idempotent
 * by design (replaying an event re-applies identical values). current_period_end
 * is only written when known, so an event that lacks it never clobbers a value a
 * previous event already set.
 */
async function upsertSubscription(
  supabase: AdminSupabaseClient,
  params: {
    organizationId: string;
    stripeSubscriptionId: string;
    plan: string;
    status: SubscriptionStatus;
    currentPeriodEnd?: string | null;
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    organization_id: params.organizationId,
    plan: params.plan,
    status: params.status,
    stripe_subscription_id: params.stripeSubscriptionId,
  };
  if (params.currentPeriodEnd) {
    row.current_period_end = params.currentPeriodEnd;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("subscriptions") as any).upsert(row, {
    onConflict: "stripe_subscription_id",
  });
  if (error) {
    throw error;
  }
}

async function requireOrg(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
  eventType: string,
): Promise<Tables<"organizations">> {
  const customerId = customerIdOf(object);
  const org = await resolveOrgByCustomer(supabase, customerId);
  if (!org) {
    throw new UnresolvedCustomerError(customerId, eventType);
  }
  return org;
}

// ── per-event transitions ────────────────────────────────────────────────────

async function handleCheckoutCompleted(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
): Promise<string> {
  const org = await requireOrg(supabase, object, "checkout.session.completed");

  const metaPlan =
    typeof object.metadata?.plan === "string" && isBillingPlan(object.metadata.plan)
      ? object.metadata.plan
      : null;
  const plan = metaPlan ?? org.plan;
  const status: SubscriptionStatus = "active";

  await updateOrganization(supabase, org.id, { plan, subscription_status: status });

  const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
  if (subscriptionId) {
    await upsertSubscription(supabase, {
      organizationId: org.id,
      plan,
      status,
      stripeSubscriptionId: subscriptionId,
    });
  }
  return org.id;
}

async function handleInvoicePaid(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
): Promise<string> {
  const org = await requireOrg(supabase, object, "invoice.paid");
  const status: SubscriptionStatus = "active";

  await updateOrganization(supabase, org.id, { subscription_status: status });

  const subscriptionId = invoiceSubscriptionId(object);
  if (subscriptionId) {
    await upsertSubscription(supabase, {
      currentPeriodEnd: unixToIso(object.lines?.data?.[0]?.period?.end),
      organizationId: org.id,
      plan: org.plan,
      status,
      stripeSubscriptionId: subscriptionId,
    });
  }
  return org.id;
}

async function handlePaymentFailed(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
): Promise<string> {
  const org = await requireOrg(supabase, object, "invoice.payment_failed");
  const status: SubscriptionStatus = "past_due";

  await updateOrganization(supabase, org.id, { subscription_status: status });

  const subscriptionId = invoiceSubscriptionId(object);
  if (subscriptionId) {
    await upsertSubscription(supabase, {
      organizationId: org.id,
      plan: org.plan,
      status,
      stripeSubscriptionId: subscriptionId,
    });
  }
  return org.id;
}

async function handleSubscriptionUpdated(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
): Promise<string> {
  const org = await requireOrg(supabase, object, "customer.subscription.updated");

  const priceId = object.items?.data?.[0]?.price?.id ?? null;
  const plan = planForStripePriceId(priceId) ?? org.plan;
  const status = mapStripeStatus(String(object.status ?? ""));

  await updateOrganization(supabase, org.id, { plan, subscription_status: status });

  if (typeof object.id === "string") {
    await upsertSubscription(supabase, {
      currentPeriodEnd: unixToIso(object.current_period_end),
      organizationId: org.id,
      plan,
      status,
      stripeSubscriptionId: object.id,
    });
  }
  return org.id;
}

async function handleSubscriptionDeleted(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
): Promise<string> {
  const org = await requireOrg(supabase, object, "customer.subscription.deleted");
  const status: SubscriptionStatus = "canceled";

  // Keep org.plan for history — gating keys off status AND plan, so a canceled
  // org still records which plan it had.
  await updateOrganization(supabase, org.id, { subscription_status: status });

  if (typeof object.id === "string") {
    await upsertSubscription(supabase, {
      currentPeriodEnd: unixToIso(object.current_period_end),
      organizationId: org.id,
      plan: org.plan,
      status,
      stripeSubscriptionId: object.id,
    });
  }
  return org.id;
}

/**
 * Apply the state transition for one ledger event. Returns the resolved org id
 * (null for unhandled event types, which are acknowledged as a no-op). Throws
 * UnresolvedCustomerError when a handled event can't be mapped to an org.
 */
export async function applyBillingEvent(
  supabase: AdminSupabaseClient,
  ledger: Tables<"billing_events">,
): Promise<{ organizationId: string | null }> {
  if (!HANDLED_EVENT_TYPES.has(ledger.type)) {
    return { organizationId: ledger.organization_id };
  }

  const event = ledger.payload as unknown as Stripe.Event;
  const object = event.data?.object as unknown as StripeEventObject;

  switch (ledger.type) {
    case "checkout.session.completed":
      return { organizationId: await handleCheckoutCompleted(supabase, object) };
    case "invoice.paid":
      return { organizationId: await handleInvoicePaid(supabase, object) };
    case "invoice.payment_failed":
      return { organizationId: await handlePaymentFailed(supabase, object) };
    case "customer.subscription.updated":
      return { organizationId: await handleSubscriptionUpdated(supabase, object) };
    case "customer.subscription.deleted":
      return { organizationId: await handleSubscriptionDeleted(supabase, object) };
    default:
      return { organizationId: ledger.organization_id };
  }
}

async function markBillingEventProcessed(
  supabase: AdminSupabaseClient,
  eventId: string,
  organizationId: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = { processed_at: nowIso() };
  if (organizationId) {
    // Backfill the ledger row's org so tenants can see their own event rows.
    patch.organization_id = organizationId;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("billing_events") as any).update(patch).eq("id", eventId);
  if (error) {
    throw error;
  }
}

/**
 * Worker-facing: process one claimed job. Loads its ledger row, applies the
 * transition idempotently, stamps processed_at, and completes the job. An
 * already-processed ledger row (crash recovery / duplicate claim) is a no-op that
 * just completes the job. UnresolvedCustomerError (and any other error) fails the
 * job (dead-letter) with the ledger row left intact, and is rethrown so the
 * worker logs it.
 */
export async function processBillingEventJob(
  supabase: AdminSupabaseClient,
  job: Tables<"billing_event_jobs">,
): Promise<void> {
  const { data, error } = await supabase
    .from("billing_events")
    .select("*")
    .eq("id", job.billing_event_id)
    .single();

  if (error || !data) {
    const reason = error?.message ?? "Billing event ledger row not found.";
    await failBillingEventJob(supabase, job.id, reason);
    throw error ?? new Error(reason);
  }

  const ledger = data as Tables<"billing_events">;

  try {
    if (ledger.processed_at) {
      await completeBillingEventJob(supabase, job.id);
      return;
    }

    const { organizationId } = await applyBillingEvent(supabase, ledger);
    await markBillingEventProcessed(supabase, ledger.id, organizationId);
    await completeBillingEventJob(supabase, job.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Billing event processing failed.";
    if (err instanceof UnresolvedCustomerError) {
      console.error(
        `[billing/processor] UNRESOLVED customer for event ${ledger.stripe_event_id} (${ledger.type}); ` +
          `left unprocessed for manual review: ${reason}`,
      );
    } else {
      console.error(
        `[billing/processor] event ${ledger.stripe_event_id} (${ledger.type}) failed: ${reason}`,
      );
    }
    await failBillingEventJob(supabase, job.id, reason);
    throw err;
  }
}
