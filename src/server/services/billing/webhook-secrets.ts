/**
 * Stripe webhook signing secrets: a primary and an OPTIONAL secondary per endpoint.
 *
 *   /api/webhooks/stripe          STRIPE_WEBHOOK_SECRET          (+ STRIPE_WEBHOOK_SECRET_2)
 *   /api/webhooks/stripe/connect  STRIPE_CONNECT_WEBHOOK_SECRET  (+ STRIPE_CONNECT_WEBHOOK_SECRET_2)
 *
 * Every Stripe endpoint has its own secret. The second slot lets two endpoints deliver to the
 * same route for a while: for the Everdoer move (REBRAND_PLAN.md §2) the plan is to edit each
 * endpoint's URL in place, which keeps its secret, but if a NEW endpoint is ever added (on the
 * new host) its secret goes in *_2 until the old endpoint is deleted. Also usable for a secret
 * roll. The primary is still required; *_2 is never a substitute for it.
 *
 * The raw body and the stripe-signature header are passed through untouched; each secret is
 * tried with Stripe's own constructEvent (timestamp tolerance included).
 */
import type Stripe from "stripe";

interface WebhookVerifier {
  constructEvent(payload: string | Buffer, header: string | Buffer | string[], secret: string): Stripe.Event;
}

/** The secondary secret for `primaryEnvName` (`<name>_2`), or null when unset/blank. */
export function secondaryWebhookSecret(primaryEnvName: string, env: Record<string, string | undefined> = process.env): string | null {
  return env[`${primaryEnvName}_2`]?.trim() || null;
}

/**
 * Verify against the primary secret, then the secondary (when set). Returns the event from the
 * first secret that verifies; when none does, throws the PRIMARY secret's error (so the logs read
 * exactly as before).
 */
export function constructStripeEvent(
  webhooks: WebhookVerifier,
  payload: string,
  signature: string,
  primary: string,
  secondary: string | null,
): Stripe.Event {
  try {
    return webhooks.constructEvent(payload, signature, primary);
  } catch (primaryErr) {
    if (!secondary || secondary === primary) throw primaryErr;
    try {
      return webhooks.constructEvent(payload, signature, secondary);
    } catch {
      throw primaryErr;
    }
  }
}
