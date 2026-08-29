/**
 * Per-tenant Stripe via Connect.
 *
 * The platform holds ONE Stripe key. Each tenant connects its own Standard
 * account, and every charge is created ON that account by passing the account id
 * as a request option (the Stripe-Account header). That is a DIRECT charge:
 *
 *   • funds land in the tenant's balance, not the platform's
 *   • refunds and chargebacks hit the tenant's account
 *   • the tenant's statement descriptor and tax registration apply
 *   • the tenant's customers never see the platform
 *
 * That last point is the same rule the branding code enforces, so the payment
 * model and the presentation model agree rather than fighting each other.
 *
 * The tenant unit is the COMPANY: `a1-group` is the organization, and the brands
 * are companies inside it. A company always knows its organization, so this is
 * strictly finer-grained than org scoping, never coarser.
 *
 * Deliberately separate from `billing/stripe.ts`, which is the platform's own
 * account billing orgs for their subscriptions. Same key, different purpose:
 * that module charges FOR us, this one charges ON BEHALF OF a tenant. Neither
 * should ever be used for the other.
 *
 * NOTE what is absent: no tenant secret keys, no per-tenant env vars, no
 * per-tenant webhook endpoints. Onboarding a tenant is a self-serve flow rather
 * than three ops actions.
 */
import type Stripe from "stripe";

import { getStripeClient } from "@/server/services/billing/stripe";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export class CompanyStripeError extends Error {
  constructor(
    message: string,
    readonly code: "not_connected" | "charges_disabled" | "company_not_found",
    readonly companyId: string,
  ) {
    super(message);
    this.name = "CompanyStripeError";
  }
}

export interface CompanyStripeConfig {
  companyId: string;
  organizationId: string;
  name: string | null;
  /** `acct_…` — the tenant's connected account. */
  accountId: string;
  accountLabel: string | null;
  mode: "test" | "live" | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** What a cardholder reads. See sanitizeStatementDescriptorSuffix. */
  statementDescriptorSuffix: string | null;
}

const SELECT =
  "id, name, organization_id, stripe_connected_account_id, stripe_account_label, stripe_mode, " +
  "stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, stripe_statement_descriptor_suffix";

async function loadCompany(companyId: string): Promise<Db> {
  const db = createSupabaseAdminClient() as Db;
  const { data, error } = await db.from("companies").select(SELECT).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new CompanyStripeError(`Company ${companyId} not found.`, "company_not_found", companyId);
  }
  return data;
}

/**
 * The tenant's Stripe configuration.
 *
 * Throws when the tenant has not connected an account. Deliberately NO fallback
 * to the platform account: a silent fallback would charge a customer into the
 * platform's balance, which is both the wrong money and the wrong merchant of
 * record.
 */
export async function getCompanyStripeConfig(companyId: string): Promise<CompanyStripeConfig> {
  const company = await loadCompany(companyId);
  const accountId: string | null = company.stripe_connected_account_id ?? null;

  if (!accountId) {
    throw new CompanyStripeError(
      `Company ${companyId} has not connected a Stripe account.`,
      "not_connected",
      companyId,
    );
  }

  return {
    companyId,
    organizationId: company.organization_id,
    name: company.name ?? null,
    accountId,
    accountLabel: company.stripe_account_label ?? null,
    mode: (company.stripe_mode as "test" | "live" | null) ?? null,
    chargesEnabled: company.stripe_charges_enabled === true,
    payoutsEnabled: company.stripe_payouts_enabled === true,
    detailsSubmitted: company.stripe_details_submitted === true,
    statementDescriptorSuffix: sanitizeStatementDescriptorSuffix(
      company.stripe_statement_descriptor_suffix ?? company.name ?? null,
    ),
  };
}

/** True when the tenant can actually take a payment. Gates UI without throwing. */
export async function isCompanyStripeReady(companyId: string): Promise<boolean> {
  try {
    const cfg = await getCompanyStripeConfig(companyId);
    return cfg.chargesEnabled;
  } catch {
    return false;
  }
}

/**
 * Config for a tenant that is ready to CHARGE.
 *
 * Connecting an account and being able to accept money are different things:
 * Stripe onboarding can complete while `charges_enabled` is still false pending
 * verification. Checking here turns that into a clear operator-facing error
 * rather than an opaque Stripe rejection at the moment a customer taps Pay.
 */
export async function requireChargeableCompany(companyId: string): Promise<CompanyStripeConfig> {
  const cfg = await getCompanyStripeConfig(companyId);
  if (!cfg.chargesEnabled) {
    throw new CompanyStripeError(
      `Company ${companyId} has connected Stripe but cannot accept charges yet ` +
        `(details_submitted=${cfg.detailsSubmitted}). Finish Stripe onboarding.`,
      "charges_disabled",
      companyId,
    );
  }
  return cfg;
}

/**
 * Request options that direct an API call at the tenant's account.
 *
 * Every merchant-side Stripe call must pass these. Omitting them silently
 * executes against the PLATFORM account — the exact failure this module exists to
 * prevent — so callers take the whole options object rather than assembling the
 * header themselves.
 */
export function onAccount(cfg: CompanyStripeConfig): Stripe.RequestOptions {
  return { stripeAccount: cfg.accountId };
}

/** The platform client. A Connect call is the platform key + a Stripe-Account header. */
export function getPlatformStripe(): Stripe {
  return getStripeClient();
}

/**
 * Make a string safe to send as `statement_descriptor_suffix`.
 *
 * Stripe rejects a charge outright if the descriptor is malformed, so a bad brand
 * name must not be able to fail a payment. The rules Stripe enforces: `< > \ " ' *`
 * are forbidden, the combined account prefix + suffix is capped at 22 characters,
 * and it must contain at least one letter.
 *
 * Returns null rather than something broken; the caller then omits the field and
 * the connected account's own default applies.
 */
export function sanitizeStatementDescriptorSuffix(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[<>\\"'*]/g, " ")
    .replace(/[^A-Za-z0-9 .,&()+/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22)
    .trim();

  if (cleaned.length === 0) return null;
  if (!/[A-Za-z]/.test(cleaned)) return null;
  return cleaned;
}

/** Shape guard for a connected account id. */
export function isConnectedAccountId(value: string | null | undefined): boolean {
  return typeof value === "string" && /^acct_[A-Za-z0-9]+$/.test(value);
}
