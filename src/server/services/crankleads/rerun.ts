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
  provisionPurchase,
  requeueDeferredBillingEvents,
  type ProvisionDeps,
} from "@/server/services/crankleads/provision";
import { findPurchaseBySession, type AdminClient } from "@/server/services/crankleads/purchases";

export interface ProvisionJobArgs {
  sessionId: string | null;
}

/** `--session cs_test_…` (or `--session=cs_test_…`). */
export function parseProvisionJobArgs(argv: readonly string[]): ProvisionJobArgs {
  let sessionId: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--session") sessionId = argv[i + 1] ?? null;
    else if (arg.startsWith("--session=")) sessionId = arg.slice("--session=".length);
  }
  return { sessionId: sessionId?.trim() || null };
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
    if (session.payment_status !== "paid") {
      return { outcome: "not_paid", organizationId: null, detail: `Stripe says payment_status=${session.payment_status}` };
    }
    const organizationId = await handleCrankleadsCheckoutPaid(admin, { ...session }, { finalAttempt: true, deps: options.deps });
    return { outcome: "provisioned", organizationId, detail: "provisioned from the Stripe session" };
  }

  const organizationId = await provisionPurchase(admin, purchase.id, { finalAttempt: true, deps: options.deps });
  return { outcome: "provisioned", organizationId, detail: `provisioned (was ${purchase.status})` };
}
