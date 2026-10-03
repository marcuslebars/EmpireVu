import type Stripe from "stripe";

import type { Inserts, Tables, Updates } from "@/server/db/database.types";
import { fromJson, toJson } from "@/server/db/json";
import { isBillingPlan, type SubscriptionStatus } from "@/server/services/billing/config";
import { billingRetryDelaySeconds, DeferBillingEventError } from "@/server/services/billing/defer";
import { planForStripePriceId } from "@/server/services/billing/env";
import {
  completeBillingEventJob,
  failBillingEventJob,
  retryBillingEventJob,
} from "@/server/services/billing/jobs";
import { crankleadsTierForPriceId } from "@/server/services/crankleads/config";
import {
  crankleadsPurchasePendingFor,
  handleCrankleadsCheckoutPaid,
  isCrankleadsObject,
} from "@/server/services/crankleads/provision";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminSupabaseClient = ReturnType<typeof createSupabaseAdminClient>;

// Stripe event objects are a 70+ member discriminated union; we read a handful of
// fields defensively rather than narrow every variant.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeEventObject = Record<string, any>;

/** Event types whose state transitions this processor applies. */
const HANDLED_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  // Only acted on for CrankLeads purchases (delayed payment methods); a no-op otherwise.
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/** Options the worker passes through to the per-event handlers. */
export interface ApplyBillingEventOptions {
  /** This is the job's last automatic attempt (attempt_count >= max_attempts). */
  finalAttempt?: boolean;
}

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
  return customerIdOf(event.data?.object as StripeEventObject | undefined);
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
  const { data, error } = await supabase.rpc("record_billing_event", {
    // p_organization_id defaults to null in the DB function — the org is resolved at
    // process time, not here.
    p_payload: toJson(event),
    p_stripe_event_id: event.id,
    p_type: event.type,
  });

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
  patch: Updates<"organizations">,
): Promise<void> {
  const { error } = await supabase.from("organizations").update(patch).eq("id", organizationId);
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
  const row: Inserts<"subscriptions"> = {
    organization_id: params.organizationId,
    plan: params.plan,
    status: params.status,
    stripe_subscription_id: params.stripeSubscriptionId,
  };
  if (params.currentPeriodEnd) {
    row.current_period_end = params.currentPeriodEnd;
  }

  const { error } = await supabase.from("subscriptions").upsert(row, {
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
    // A CrankLeads purchase whose org is still being provisioned (the subscription/invoice
    // events can be processed before checkout.session.completed finishes): retry later
    // instead of dead-lettering.
    if (await crankleadsPurchasePendingFor(supabase, object)) {
      throw new DeferBillingEventError(
        `Stripe customer ${customerId ?? "(none)"} on ${eventType} belongs to a CrankLeads purchase still being provisioned.`,
      );
    }
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
  eventType = "customer.subscription.updated",
): Promise<string> {
  const org = await requireOrg(supabase, object, eventType);

  const priceId = object.items?.data?.[0]?.price?.id ?? null;
  const plan = planForStripePriceId(priceId) ?? org.plan;
  const status = mapStripeStatus(String(object.status ?? ""));

  const patch: Updates<"organizations"> = { plan, subscription_status: status };
  // A CrankLeads tier change (e.g. Catch → Close in the portal) keeps the recorded tier in step.
  const tier = crankleadsTierForPriceId(priceId);
  if (tier) {
    patch.crankleads_tier = tier;
  }
  await updateOrganization(supabase, org.id, patch);

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
 * customer.subscription.created: the same transition as .updated when the org is known
 * (or is a CrankLeads purchase still being provisioned — deferred). For an unknown,
 * non-CrankLeads customer it stays the no-op it was before this event was handled.
 */
async function handleSubscriptionCreated(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
): Promise<string | null> {
  const org = await resolveOrgByCustomer(supabase, customerIdOf(object));
  if (!org && !(await crankleadsPurchasePendingFor(supabase, object))) {
    return null;
  }
  return handleSubscriptionUpdated(supabase, object, "customer.subscription.created");
}

/**
 * A CrankLeads Checkout Session was paid: provision the owner login + org + company first
 * (exactly once — crankleads/provision.ts), then apply the normal checkout transition to
 * the new org. Null while the session is not paid yet.
 */
async function handleCrankleadsCheckout(
  supabase: AdminSupabaseClient,
  object: StripeEventObject,
  options: ApplyBillingEventOptions,
): Promise<string | null> {
  const organizationId = await handleCrankleadsCheckoutPaid(supabase, object, {
    finalAttempt: options.finalAttempt ?? false,
  });
  if (!organizationId) {
    return null;
  }
  return handleCheckoutCompleted(supabase, object);
}

/**
 * Apply the state transition for one ledger event. Returns the resolved org id
 * (null for unhandled event types, which are acknowledged as a no-op). Throws
 * UnresolvedCustomerError when a handled event can't be mapped to an org, and
 * DeferBillingEventError when it can't be mapped YET (CrankLeads provisioning).
 */
export async function applyBillingEvent(
  supabase: AdminSupabaseClient,
  ledger: Tables<"billing_events">,
  options: ApplyBillingEventOptions = {},
): Promise<{ organizationId: string | null }> {
  if (!HANDLED_EVENT_TYPES.has(ledger.type)) {
    return { organizationId: ledger.organization_id };
  }

  const event = fromJson<Stripe.Event>(ledger.payload);
  const object = event.data?.object as StripeEventObject;

  switch (ledger.type) {
    case "checkout.session.completed":
      if (isCrankleadsObject(object)) {
        return { organizationId: await handleCrankleadsCheckout(supabase, object, options) };
      }
      return { organizationId: await handleCheckoutCompleted(supabase, object) };
    case "checkout.session.async_payment_succeeded":
      if (isCrankleadsObject(object)) {
        return { organizationId: await handleCrankleadsCheckout(supabase, object, options) };
      }
      return { organizationId: ledger.organization_id };
    case "customer.subscription.created":
      return { organizationId: await handleSubscriptionCreated(supabase, object) };
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
  const patch: Updates<"billing_events"> = { processed_at: nowIso() };
  if (organizationId) {
    // Backfill the ledger row's org so tenants can see their own event rows.
    patch.organization_id = organizationId;
  }
  const { error } = await supabase.from("billing_events").update(patch).eq("id", eventId);
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

    const finalAttempt = job.attempt_count >= job.max_attempts;
    const { organizationId } = await applyBillingEvent(supabase, ledger, { finalAttempt });
    await markBillingEventProcessed(supabase, ledger.id, organizationId);
    await completeBillingEventJob(supabase, job.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Billing event processing failed.";
    if (err instanceof DeferBillingEventError && job.attempt_count < job.max_attempts) {
      // Not an error yet: re-queue with bounded backoff (attempts stay counted).
      const delay = billingRetryDelaySeconds(job.attempt_count);
      console.warn(
        `[billing/processor] event ${ledger.stripe_event_id} (${ledger.type}) deferred ` +
          `(attempt ${job.attempt_count}/${job.max_attempts}, retry in ${delay}s): ${reason}`,
      );
      await retryBillingEventJob(supabase, job.id, reason, delay);
      return;
    }
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
