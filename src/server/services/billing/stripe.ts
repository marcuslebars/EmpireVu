import Stripe from "stripe";

import { getStripeSecretKey } from "@/server/services/billing/env";

/**
 * Pinned to the API version bundled with the installed SDK (stripe@22 ->
 * "2026-07-29.dahlia"). Pinning keeps webhook payload shapes and API responses
 * stable regardless of the Stripe account's default version. When bumping the
 * `stripe` dependency, update this to the new `Stripe.LatestApiVersion`.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia" satisfies Stripe.LatestApiVersion;

let cached: Stripe | null = null;

/**
 * Server-only Stripe client. Lazily constructed so that importing this module
 * (e.g. transitively in a test) never throws when STRIPE_SECRET_KEY is absent —
 * the key is only required the first time a Stripe call is actually made.
 */
export function getStripeClient(): Stripe {
  if (!cached) {
    cached = new Stripe(getStripeSecretKey(), { apiVersion: STRIPE_API_VERSION });
  }
  return cached;
}
