// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): the operator's CrankLeads re-run job
// (`npm run job:crankleads-provision -- --session cs_...`). A CLI run has no user session;
// the purchase is selected by its Checkout Session id and provisioned through
// ./provision.ts exactly as the billing worker would. Listed in docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import type Stripe from "stripe";

import { getStripeClient } from "@/server/services/billing/stripe";
import {
  handleCrankleadsCheckoutPaid,
  isProvisionablePaymentStatus,
  provisionPurchase,
  requeueDeferredBillingEvents,
  type ProvisionDeps,
} from "@/server/services/crankleads/provision";
import {
  findPurchaseBySession,
  type AdminClient,
  type CrankleadsPurchase,
} from "@/server/services/crankleads/purchases";

export interface ProvisionJobArgs {
  sessionId: string | null;
  /** `--stuck`: sweep every purchase stuck before `provisioned`. */
  stuck: boolean;
  /** `--older-than-minutes N` for the sweep (default 15). */
  olderThanMinutes: number;
}

export const DEFAULT_STUCK_MINUTES = 15;

/** `--session cs_test_…` (or `--session=cs_test_…`), or `--stuck [--older-than-minutes N]`. */
export function parseProvisionJobArgs(argv: readonly string[]): ProvisionJobArgs {
  let sessionId: string | null = null;
  let olderThan: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--session") sessionId = argv[i + 1] ?? null;
    else if (arg.startsWith("--session=")) sessionId = arg.slice("--session=".length);
    else if (arg === "--older-than-minutes") olderThan = argv[i + 1] ?? null;
    else if (arg.startsWith("--older-than-minutes=")) olderThan = arg.slice("--older-than-minutes=".length);
  }
  const minutes = Number.parseInt(olderThan ?? "", 10);
  return {
    sessionId: sessionId?.trim() || null,
    stuck: argv.includes("--stuck"),
    olderThanMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_STUCK_MINUTES,
  };
}

export interface ProvisionJobResult {
  outcome: "provisioned" | "already_provisioned" | "not_paid" | "not_found";
  organizationId: string | null;
  detail: string;
}

/**
 * Re-run provisioning for one purchase. Works from any state:
 *   • failed / paid / stale provisioning → provision now (final attempt: a failure alerts);
 *   • checkout_created (the webhook never arrived) → ask Stripe whether it's paid, then provision;
 *   • provisioned → nothing to build, but re-drive any billing events still waiting on it.
 */
export async function runCrankleadsProvisionJob(
  admin: AdminClient,
  args: ProvisionJobArgs,
  options: { stripe?: Stripe; deps?: Partial<ProvisionDeps> } = {},
): Promise<ProvisionJobResult> {
  if (!args.sessionId) {
    throw new Error("Usage: npm run job:crankleads-provision -- --session cs_test_...");
  }
  const purchase = await findPurchaseBySession(admin, args.sessionId);

  if (purchase?.status === "provisioned" && purchase.organization_id) {
    const requeued = purchase.stripe_customer_id ? await requeueDeferredBillingEvents(admin, purchase.stripe_customer_id) : 0;
    return {
      outcome: "already_provisioned",
      organizationId: purchase.organization_id,
      detail: `already provisioned; re-queued ${requeued} waiting billing event(s)`,
    };
  }

  if (!purchase || purchase.status === "checkout_created") {
    const stripe = options.stripe ?? getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(args.sessionId);
    if (session.metadata?.source !== "crankleads") {
      return { outcome: "not_found", organizationId: null, detail: "not a CrankLeads Checkout Session" };
    }
    if (!isProvisionablePaymentStatus(session.payment_status)) {
      return { outcome: "not_paid", organizationId: null, detail: `Stripe says payment_status=${session.payment_status}` };
    }
    const organizationId = await handleCrankleadsCheckoutPaid(admin, { ...session }, { finalAttempt: true, deps: options.deps });
    return { outcome: "provisioned", organizationId, detail: "provisioned from the Stripe session" };
  }

  const organizationId = await provisionPurchase(admin, purchase.id, { finalAttempt: true, deps: options.deps });
  return { outcome: "provisioned", organizationId, detail: `provisioned (was ${purchase.status})` };
}

// ── Stuck-purchase sweep (`--stuck`, Railway cron every 15 min) ────────────────

/** Unpaid Checkout Sessions expire after 24 h; don't keep asking Stripe about abandoned ones. */
const CHECKOUT_LOOKBACK_MS = 26 * 60 * 60 * 1000;

export interface StuckSweepItem {
  purchaseId: string;
  sessionId: string | null;
  status: string;
  outcome: "provisioned" | "not_paid" | "abandoned" | "no_session" | "failed";
  detail: string;
}

/**
 * Safety net for anything the webhook path missed (webhook not configured, a job that
 * dead-lettered, a worker that died mid-claim): every purchase in checkout_created / paid /
 * provisioning whose row hasn't moved for `olderThanMinutes` is checked. checkout_created →
 * ask Stripe; paid (or no_payment_required) → provision. paid / provisioning → provision now.
 * Each attempt is a FINAL attempt, so a failure alerts the operator (OWNER_EMAIL).
 */
export async function runStuckPurchaseSweep(
  admin: AdminClient,
  options: { olderThanMinutes?: number; stripe?: Stripe; deps?: Partial<ProvisionDeps>; now?: Date } = {},
): Promise<StuckSweepItem[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMinutes ?? DEFAULT_STUCK_MINUTES) * 60 * 1000).toISOString();
  const lookback = new Date(now.getTime() - CHECKOUT_LOOKBACK_MS).toISOString();
  const { data, error } = await admin
    .from("crankleads_purchases")
    .select("*")
    .in("status", ["checkout_created", "paid", "provisioning"])
    .lt("updated_at", cutoff)
    .gt("created_at", lookback)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`stuck purchase lookup failed: ${error.message}`);

  const results: StuckSweepItem[] = [];
  let stripe: Stripe | null = options.stripe ?? null;
  for (const purchase of (data ?? []) as CrankleadsPurchase[]) {
    const base = { purchaseId: purchase.id, sessionId: purchase.stripe_checkout_session_id, status: purchase.status };
    try {
      if (purchase.status !== "checkout_created") {
        const organizationId = await provisionPurchase(admin, purchase.id, { finalAttempt: true, deps: options.deps });
        results.push({ ...base, outcome: "provisioned", detail: `org ${organizationId}` });
        continue;
      }
      if (!purchase.stripe_checkout_session_id) {
        results.push({ ...base, outcome: "no_session", detail: "Checkout Session was never created" });
        continue;
      }
      stripe ??= getStripeClient();
      const session = await stripe.checkout.sessions.retrieve(purchase.stripe_checkout_session_id);
      if (isProvisionablePaymentStatus(session.payment_status)) {
        const organizationId = await handleCrankleadsCheckoutPaid(admin, { ...session }, { finalAttempt: true, deps: options.deps });
        results.push({ ...base, outcome: "provisioned", detail: `org ${organizationId ?? "-"} (webhook was missed)` });
      } else {
        results.push({
          ...base,
          outcome: session.status === "expired" ? "abandoned" : "not_paid",
          detail: `Stripe: status=${session.status} payment_status=${session.payment_status}`,
        });
      }
    } catch (err) {
      // provisionPurchase / handleCrankleadsCheckoutPaid already alerted the operator.
      results.push({ ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
