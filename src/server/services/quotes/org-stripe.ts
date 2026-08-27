/**
 * Org-scoped Stripe resolution.
 *
 * Each tenant charges its own customers through its OWN Stripe account, so the
 * client, the webhook signing secret and the account id are all resolved per org
 * rather than read from one global env pair.
 *
 * This is deliberately separate from `billing/stripe.ts`, which stays global:
 *   billing/stripe.ts  -> the PLATFORM account. Tilotto charging orgs for their
 *                         subscription. One account, global env keys.
 *   this module        -> the MERCHANT account. An org charging ITS customers for
 *                         quote deposits and balances. One account per org.
 * Nothing here should ever be used for platform billing, or vice versa — a
 * deposit landing in Tilotto's account instead of the tenant's would be a
 * genuine mess to unwind.
 *
 * SECRETS: the org row stores the NAME of the Railway env var holding each
 * secret, not the secret. See the migration for why. The name is validated
 * against MERCHANT_ENV_PATTERN before it is ever used as a lookup key: org
 * settings are admin-editable, and without that check an org row could name any
 * variable in the process environment and have this module read it.
 */
import Stripe from "stripe";

import { STRIPE_API_VERSION } from "@/server/services/billing/stripe";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Env var names an org may point at. The prefix is the containment boundary. */
export const MERCHANT_ENV_PATTERN = /^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$/;

export class OrgStripeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "invalid_env_name"
      | "missing_secret"
      | "org_not_found",
    readonly organizationId: string,
  ) {
    super(message);
    this.name = "OrgStripeError";
  }
}

export interface OrgStripeConfig {
  organizationId: string;
  accountId: string | null;
  mode: "test" | "live" | null;
  secretKeyEnv: string;
  webhookSecretEnv: string | null;
}

/**
 * Read an env var an org has nominated. Refuses any name outside the allowlist
 * pattern, so a crafted org row cannot turn this into an arbitrary env reader.
 */
export function readMerchantEnv(
  name: string,
  organizationId: string,
  { required = true }: { required?: boolean } = {},
): string | null {
  if (!MERCHANT_ENV_PATTERN.test(name)) {
    throw new OrgStripeError(
      `Env var name "${name}" is not an allowed merchant secret name.`,
      "invalid_env_name",
      organizationId,
    );
  }
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    if (!required) return null;
    throw new OrgStripeError(
      // The NAME is safe to surface (it is not a secret) and is what the operator
      // needs in order to fix this. The value is never logged or returned.
      `Env var ${name} is not set for organization ${organizationId}.`,
      "missing_secret",
      organizationId,
    );
  }
  return value;
}

/** Load an org's merchant Stripe configuration. Throws if the org has none. */
export async function getOrgStripeConfig(organizationId: string): Promise<OrgStripeConfig> {
  const db = createSupabaseAdminClient() as Db;
  const { data: org, error } = await db
    .from("organizations")
    .select(
      "id, stripe_merchant_account_id, stripe_merchant_secret_key_env, stripe_merchant_webhook_secret_env, stripe_merchant_mode",
    )
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!org) throw new OrgStripeError(`Organization ${organizationId} not found.`, "org_not_found", organizationId);

  const secretKeyEnv: string | null = org.stripe_merchant_secret_key_env ?? null;
  if (!secretKeyEnv) {
    throw new OrgStripeError(
      `Organization ${organizationId} has no Stripe merchant account configured.`,
      "not_configured",
      organizationId,
    );
  }

  return {
    organizationId,
    accountId: org.stripe_merchant_account_id ?? null,
    mode: (org.stripe_merchant_mode as "test" | "live" | null) ?? null,
    secretKeyEnv,
    webhookSecretEnv: org.stripe_merchant_webhook_secret_env ?? null,
  };
}

/** True when the org can take payments — used to gate UI without throwing. */
export async function isOrgStripeConfigured(organizationId: string): Promise<boolean> {
  try {
    await getOrgStripeConfig(organizationId);
    return true;
  } catch {
    return false;
  }
}

// One client per org, keyed by org + env name so rotating the nominated var (or
// pointing the org at a different one) yields a fresh client rather than a stale
// cached one holding the old key.
const clients = new Map<string, Stripe>();

export function __resetOrgStripeClients(): void {
  clients.clear();
}

/** The Stripe client for an org's OWN account. */
export async function getOrgStripeClient(organizationId: string): Promise<Stripe> {
  const cfg = await getOrgStripeConfig(organizationId);
  const cacheKey = `${organizationId}:${cfg.secretKeyEnv}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const key = readMerchantEnv(cfg.secretKeyEnv, organizationId)!;
  const client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  clients.set(cacheKey, client);
  return client;
}

/**
 * The webhook signing secret for an org's own account.
 *
 * Each merchant account posts to its own endpoint (/api/webhooks/stripe/merchant/
 * {organizationId}), so the org is known from the URL before verification — we
 * never have to guess which secret to try, and one org's secret can never verify
 * another org's payload.
 */
export async function getOrgWebhookSecret(organizationId: string): Promise<string> {
  const cfg = await getOrgStripeConfig(organizationId);
  if (!cfg.webhookSecretEnv) {
    throw new OrgStripeError(
      `Organization ${organizationId} has no merchant webhook secret configured.`,
      "not_configured",
      organizationId,
    );
  }
  return readMerchantEnv(cfg.webhookSecretEnv, organizationId)!;
}

/**
 * Guard against a test-mode key in production (or the reverse). Stripe keys are
 * self-describing, so this catches a mis-set Railway var before it produces a
 * real charge in the wrong mode.
 */
export function assertKeyMatchesMode(key: string, mode: "test" | "live" | null): void {
  if (!mode) return;
  const isTestKey = key.startsWith("sk_test_") || key.startsWith("rk_test_");
  if (mode === "test" && !isTestKey) throw new Error("Org is in test mode but the key is not a test key.");
  if (mode === "live" && isTestKey) throw new Error("Org is in live mode but a test key is configured.");
}
