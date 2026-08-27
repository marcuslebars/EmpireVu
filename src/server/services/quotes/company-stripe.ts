/**
 * Per-brand Stripe resolution.
 *
 * A brand here is a COMPANY, not an organization: `a1-group` is the org, and
 * A1 Marine Storage / Marine Care / Coatings / Boatnames are companies inside it.
 * Each brand charges its own customers through its OWN Stripe account, so the
 * client, the webhook signing secret and the account id all resolve per COMPANY.
 * Org-scoping these would give the whole family one shared account.
 *
 * This is deliberately separate from `billing/stripe.ts`, which stays global:
 *   billing/stripe.ts  -> the PLATFORM account. Tilotto charging orgs for their
 *                         subscription. One account, global env keys.
 *   this module        -> the MERCHANT account. A brand charging ITS customers
 *                         for quote deposits and balances. One per company.
 * Nothing here should ever be used for platform billing, or vice versa — a
 * deposit landing in Tilotto's account instead of the brand's would be a genuine
 * mess to unwind.
 *
 * SECRETS: the company row stores the NAME of the Railway env var holding each
 * secret, not the secret. See the migration for why. The name is validated
 * against MERCHANT_ENV_PATTERN before it is ever used as a lookup key: company
 * settings are admin-editable, and without that check a crafted row could name
 * any variable in the process environment and have this module read it.
 */
import Stripe from "stripe";

import { STRIPE_API_VERSION } from "@/server/services/billing/stripe";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Env var names an org may point at. The prefix is the containment boundary. */
export const MERCHANT_ENV_PATTERN = /^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$/;

export class CompanyStripeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "invalid_env_name"
      | "missing_secret"
      | "company_not_found",
    readonly companyId: string,
  ) {
    super(message);
    this.name = "CompanyStripeError";
  }
}

export interface CompanyStripeConfig {
  companyId: string;
  organizationId: string;
  /** Human label for the account, e.g. "A1 Marine Storage (live)". Never a secret. */
  accountLabel: string | null;
  /** Brand name, for the Checkout line description. */
  name: string | null;
  /**
   * Appended to the ACCOUNT's static descriptor prefix on the cardholder's
   * statement. This is what keeps brands apart when they share one Stripe
   * account, which the A1 group companies do.
   */
  statementDescriptorSuffix: string | null;
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
  companyId: string,
  { required = true }: { required?: boolean } = {},
): string | null {
  if (!MERCHANT_ENV_PATTERN.test(name)) {
    throw new CompanyStripeError(
      `Env var name "${name}" is not an allowed merchant secret name.`,
      "invalid_env_name",
      companyId,
    );
  }
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    if (!required) return null;
    throw new CompanyStripeError(
      // The NAME is safe to surface (it is not a secret) and is what the operator
      // needs in order to fix this. The value is never logged or returned.
      `Env var ${name} is not set for company ${companyId}.`,
      "missing_secret",
      companyId,
    );
  }
  return value;
}

/** Load a company's merchant Stripe configuration. Throws if it has none. */
export async function getCompanyStripeConfig(companyId: string): Promise<CompanyStripeConfig> {
  const db = createSupabaseAdminClient() as Db;
  const { data: org, error } = await db
    .from("companies")
    .select(
      "id, name, organization_id, stripe_account_label, stripe_account_id, stripe_secret_key_ref, stripe_webhook_secret_ref, stripe_publishable_key_ref, stripe_mode, stripe_statement_descriptor_suffix",
    )
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!org) throw new CompanyStripeError(`Company ${companyId} not found.`, "org_not_found", companyId);

  const secretKeyEnv: string | null = org.stripe_secret_key_ref ?? null;
  if (!secretKeyEnv) {
    throw new CompanyStripeError(
      `Company ${companyId} has no Stripe merchant account configured.`,
      "not_configured",
      companyId,
    );
  }

  return {
    companyId,
    name: org.name ?? null,
    statementDescriptorSuffix: sanitizeStatementDescriptorSuffix(
      org.stripe_statement_descriptor_suffix ?? org.name ?? null,
    ),
    organizationId: org.organization_id,
    accountLabel: org.stripe_account_label ?? null,
    accountId: org.stripe_account_id ?? null,
    mode: (org.stripe_mode as "test" | "live" | null) ?? null,
    secretKeyEnv,
    webhookSecretEnv: org.stripe_webhook_secret_ref ?? null,
  };
}

/** True when the brand can take payments — used to gate UI without throwing. */
export async function isCompanyStripeConfigured(companyId: string): Promise<boolean> {
  try {
    await getCompanyStripeConfig(companyId);
    return true;
  } catch {
    return false;
  }
}

// One client per company, keyed by company + env name so rotating the nominated var (or
// pointing the company at a different one) yields a fresh client rather than a stale
// cached one holding the old key.
const clients = new Map<string, Stripe>();

export function __resetCompanyStripeClients(): void {
  clients.clear();
}

/** The Stripe client for a brand's OWN account. */
export async function getCompanyStripeClient(companyId: string): Promise<Stripe> {
  const cfg = await getCompanyStripeConfig(companyId);
  const cacheKey = `${companyId}:${cfg.secretKeyEnv}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const key = readMerchantEnv(cfg.secretKeyEnv, companyId)!;
  const client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  clients.set(cacheKey, client);
  return client;
}

/**
 * The webhook signing secret for a brand's own account.
 *
 * Each merchant account posts to its own endpoint
 * (/api/webhooks/stripe/merchant/{companyId}), so the brand is known from the URL
 * before verification — we never guess which secret to try, and one brand's
 * secret can never verify another brand's payload.
 */
export async function getCompanyWebhookSecret(companyId: string): Promise<string> {
  const cfg = await getCompanyStripeConfig(companyId);
  if (!cfg.webhookSecretEnv) {
    throw new CompanyStripeError(
      `Company ${companyId} has no merchant webhook secret configured.`,
      "not_configured",
      companyId,
    );
  }
  return readMerchantEnv(cfg.webhookSecretEnv, companyId)!;
}

/**
 * Guard against a test-mode key in production (or the reverse). Stripe keys are
 * self-describing, so this catches a mis-set Railway var before it produces a
 * real charge in the wrong mode.
 */
export function assertKeyMatchesMode(key: string, mode: "test" | "live" | null): void {
  if (!mode) return;
  const isTestKey = key.startsWith("sk_test_") || key.startsWith("rk_test_");
  if (mode === "test" && !isTestKey) throw new Error("Brand is in test mode but the key is not a test key.");
  if (mode === "live" && isTestKey) throw new Error("Brand is in live mode but a test key is configured.");
}


/**
 * Make a string safe to send as `statement_descriptor_suffix`.
 *
 * Stripe rejects a charge outright if the descriptor is malformed, so a bad
 * brand name must not be able to fail a payment. The rules Stripe enforces:
 *   • `< > \ " ' *` are forbidden,
 *   • the combined account prefix + suffix is capped at 22 characters, and
 *   • it must contain at least one letter.
 *
 * We cap the SUFFIX at 22 and leave headroom to the operator, because the
 * account's prefix is set in the Stripe dashboard and isn't visible from here —
 * see the runbook note about keeping the prefix short.
 *
 * Returns null rather than a broken value when nothing usable survives; the
 * caller then simply omits the field and the account default applies.
 */
export function sanitizeStatementDescriptorSuffix(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[<>\\"'*]/g, " ") // characters Stripe forbids outright
    .replace(/[^A-Za-z0-9 .,&()+/-]/g, " ") // anything else non-portable
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22)
    .trim();

  if (cleaned.length === 0) return null;
  if (!/[A-Za-z]/.test(cleaned)) return null; // Stripe requires a letter
  return cleaned;
}
