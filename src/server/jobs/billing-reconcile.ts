import type { Tables } from "@/server/db/database.types";
import { planForStripePriceId } from "@/server/services/billing/env";
import { mapStripeStatus } from "@/server/services/billing/events";
import { getStripeClient } from "@/server/services/billing/stripe";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

/**
 * Nightly billing reconciliation. Lists active/past_due subscriptions from Stripe
 * (the source of truth) and diffs them against local subscriptions/organizations
 * state, logging any drift LOUDLY. READ-ONLY — it alerts, it never auto-corrects.
 * Run via `npm run job:billing-reconcile` (wire to Railway cron nightly).
 *
 * Exit code is non-zero when mismatches are found, so a scheduler/alerting can key
 * off it.
 */
async function reconcile(): Promise<number> {
  const stripe = getStripeClient();
  const supabase = createSupabaseAdminClient();

  const { data: localRows, error } = await supabase.from("subscriptions").select("*");
  if (error) {
    throw error;
  }

  const localById = new Map<string, Tables<"subscriptions">>();
  for (const row of (localRows ?? []) as Tables<"subscriptions">[]) {
    localById.set(row.stripe_subscription_id, row);
  }

  let checked = 0;
  let mismatches = 0;
  const seenStripeIds = new Set<string>();

  for (const status of ["active", "past_due"] as const) {
    for await (const sub of stripe.subscriptions.list({ limit: 100, status })) {
      checked += 1;
      seenStripeIds.add(sub.id);

      const stripeStatus = mapStripeStatus(sub.status);
      const priceId = sub.items?.data?.[0]?.price?.id ?? null;
      const stripePlan = planForStripePriceId(priceId);
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      const local = localById.get(sub.id);

      if (!local) {
        mismatches += 1;
        console.error(
          `[reconcile] MISSING LOCAL: Stripe subscription ${sub.id} ` +
            `(customer ${customerId ?? "?"}, status ${stripeStatus}, plan ${stripePlan ?? "?"}) ` +
            `has no local subscriptions row.`,
        );
        continue;
      }

      if (local.status !== stripeStatus) {
        mismatches += 1;
        console.error(
          `[reconcile] STATUS DRIFT: subscription ${sub.id} local=${local.status} stripe=${stripeStatus}.`,
        );
      }
      if (stripePlan && local.plan !== stripePlan) {
        mismatches += 1;
        console.error(
          `[reconcile] PLAN DRIFT: subscription ${sub.id} local=${local.plan} stripe=${stripePlan}.`,
        );
      }
    }
  }

  // Local rows that claim active/past_due but Stripe didn't return (likely canceled
  // in Stripe without the webhook landing).
  for (const [id, local] of localById) {
    if ((local.status === "active" || local.status === "past_due") && !seenStripeIds.has(id)) {
      mismatches += 1;
      console.error(
        `[reconcile] STALE LOCAL: subscription ${id} is '${local.status}' locally but was not ` +
          `returned by Stripe's active/past_due list — it may be canceled in Stripe.`,
      );
    }
  }

  console.log(
    `[reconcile] done: checked ${checked} Stripe subscription(s), ${mismatches} mismatch(es). ` +
      `Read-only — no changes applied.`,
  );
  return mismatches;
}

reconcile()
  .then((mismatches) => process.exit(mismatches > 0 ? 1 : 0))
  .catch((err) => {
    console.error("[reconcile] crashed", err);
    process.exit(1);
  });
