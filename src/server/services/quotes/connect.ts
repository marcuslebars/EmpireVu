/**
 * Stripe Connect onboarding — a tenant connects its own account, self-serve.
 *
 * Standard accounts, chosen deliberately over Express or Custom:
 *   • the tenant owns the Stripe relationship and its own dashboard, which is the
 *     right shape when they are running a real business, not a gig on a
 *     marketplace;
 *   • liability for disputes and negative balances sits with them, not the
 *     platform;
 *   • Stripe's docs steer direct charges away from legacy Express/Custom.
 *
 * The flow is: create an Account, hand the tenant an Account Link, let Stripe
 * host the onboarding, then keep capability state fresh from `account.updated`
 * webhooks. The platform never sees or stores a tenant credential.
 */
import type Stripe from "stripe";

import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { getPlatformStripe } from "./company-stripe";
import { getQuotesConfig } from "./config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export class ConnectError extends Error {
  constructor(
    message: string,
    readonly code: "company_not_found" | "already_connected" | "not_connected",
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

export interface ConnectOnboardingLink {
  accountId: string;
  url: string;
  /** Account Links are single-use and short-lived; regenerate rather than cache. */
  expiresAt: number;
}

async function loadCompany(companyId: string): Promise<Db> {
  const db = createSupabaseAdminClient() as Db;
  const { data, error } = await db
    .from("companies")
    .select("id, name, organization_id, stripe_connected_account_id, brand_reply_email, brand_website_url")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ConnectError(`Company ${companyId} not found.`, "company_not_found");
  return data;
}

/**
 * Find-or-create the tenant's connected account, then return a fresh onboarding
 * link.
 *
 * The account id is persisted IMMEDIATELY after creation, before the link is
 * generated: if link generation fails we must not create a second orphan account
 * on the next attempt. Stripe accounts cannot be deleted once they have activity,
 * so orphans are permanent clutter in the platform dashboard.
 */
export async function startConnectOnboarding(
  companyId: string,
  opts: { returnUrl: string; refreshUrl: string },
): Promise<ConnectOnboardingLink> {
  const company = await loadCompany(companyId);
  const stripe = getPlatformStripe();
  let accountId: string | null = company.stripe_connected_account_id ?? null;

  if (!accountId) {
    const account = await stripe.accounts.create(
      {
        type: "standard",
        email: company.brand_reply_email ?? undefined,
        business_profile: {
          name: company.name ?? undefined,
          url: company.brand_website_url ?? undefined,
        },
        metadata: { company_id: companyId, organization_id: company.organization_id },
      },
      // Keyed by company so a double-click cannot create two accounts.
      { idempotencyKey: `connect-account-${companyId}` },
    );
    accountId = account.id;

    const db = createSupabaseAdminClient() as Db;
    const { error } = await db
      .from("companies")
      .update({ stripe_connected_account_id: accountId, stripe_connect_updated_at: new Date().toISOString() })
      .eq("id", companyId);
    if (error) {
      // The account exists in Stripe but we failed to record it. Surface loudly:
      // retrying would orphan this one and create another.
      console.error(`[connect] created account ${accountId} but failed to persist it:`, error);
      throw error;
    }
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    return_url: opts.returnUrl,
    refresh_url: opts.refreshUrl,
  });

  return { accountId, url: link.url, expiresAt: link.expires_at };
}

/**
 * Mirror an account's capability state onto the company row.
 *
 * Driven by `account.updated`, so the app can tell an operator WHY checkout is
 * unavailable without a live API call on every request. `charges_enabled` is the
 * one that actually gates trading — onboarding can complete with it still false
 * while Stripe verifies.
 */
export async function syncConnectedAccountState(account: Stripe.Account): Promise<void> {
  const db = createSupabaseAdminClient() as Db;

  const { data, error } = await db
    .from("companies")
    .update({
      stripe_charges_enabled: account.charges_enabled === true,
      stripe_payouts_enabled: account.payouts_enabled === true,
      stripe_details_submitted: account.details_submitted === true,
      stripe_requirements: account.requirements ?? null,
      stripe_connect_updated_at: new Date().toISOString(),
    })
    .eq("stripe_connected_account_id", account.id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    // An account we do not recognise. Not an error — the platform may have other
    // connected accounts — but worth seeing if it is unexpected.
    console.warn(`[connect] account.updated for unmapped account ${account.id}`);
  }
}

/** Live capability read, for the admin screen's "refresh" action. */
export async function refreshConnectedAccount(companyId: string): Promise<Stripe.Account> {
  const company = await loadCompany(companyId);
  const accountId: string | null = company.stripe_connected_account_id ?? null;
  if (!accountId) {
    throw new ConnectError(`Company ${companyId} has no connected account.`, "not_connected");
  }
  const account = await getPlatformStripe().accounts.retrieve(accountId);
  await syncConnectedAccountState(account);
  return account;
}

/** Where Stripe sends the tenant back to after onboarding. */
export function onboardingUrls(companyId: string): { returnUrl: string; refreshUrl: string } {
  const base = (process.env.APP_BASE_URL ?? getQuotesConfig().publicBaseUrl).replace(/\/$/, "");
  return {
    returnUrl: `${base}/settings/payments?company=${encodeURIComponent(companyId)}&connected=1`,
    // Account Links expire; Stripe calls refresh_url to get a fresh one.
    refreshUrl: `${base}/settings/payments?company=${encodeURIComponent(companyId)}&refresh=1`,
  };
}
