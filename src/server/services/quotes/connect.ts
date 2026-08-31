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

const COMPANY_SELECT =
  "id, name, organization_id, stripe_connected_account_id, stripe_mode, " +
  "stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, " +
  "stripe_requirements, stripe_connect_updated_at, brand_reply_email, brand_website_url";

/**
 * Load a company, scoped to its organization.
 *
 * `organizationId` is REQUIRED, and every exported function here takes it,
 * because these run on the ADMIN client — RLS is not standing in the way. Without
 * it a member of one org could aim onboarding at another org's company and
 * attach a Stripe account to a business they do not own. Making the parameter
 * mandatory means a future caller cannot forget: a route holding only a
 * companyId will not compile.
 *
 * A company in a different org reports `company_not_found` rather than
 * "forbidden", so the error does not confirm that the id exists.
 */
async function loadCompany(companyId: string, organizationId: string): Promise<Db> {
  const db = createSupabaseAdminClient() as Db;
  const { data, error } = await db
    .from("companies")
    .select(COMPANY_SELECT)
    .eq("id", companyId)
    .eq("organization_id", organizationId)
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
  organizationId: string,
  opts: { returnUrl: string; refreshUrl: string },
): Promise<ConnectOnboardingLink> {
  const company = await loadCompany(companyId, organizationId);
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
export async function refreshConnectedAccount(
  companyId: string,
  organizationId: string,
): Promise<Stripe.Account> {
  const company = await loadCompany(companyId, organizationId);
  const accountId: string | null = company.stripe_connected_account_id ?? null;
  if (!accountId) {
    throw new ConnectError(`Company ${companyId} has no connected account.`, "not_connected");
  }
  const account = await getPlatformStripe().accounts.retrieve(accountId);
  await syncConnectedAccountState(account);
  return account;
}

/**
 * What the settings screen shows. Read from the mirrored columns, not Stripe, so
 * rendering the page costs no API call — `account.updated` keeps them fresh, and
 * the sync action exists for when someone does not want to wait for a webhook.
 */
export interface ConnectStatus {
  companyId: string;
  companyName: string | null;
  connected: boolean;
  /** `acct_...`. Not a secret — it is a public identifier, unlike a key. */
  accountId: string | null;
  mode: "test" | "live" | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** What Stripe is still waiting for. Empty when nothing is outstanding. */
  requirementsDue: string[];
  /** Set when Stripe has given a deadline for `requirementsDue`. */
  requirementsDeadline: number | null;
  /** True only when this company can actually take money right now. */
  readyToCharge: boolean;
  updatedAt: string | null;
}

/** Requirement arrays Stripe may or may not populate; treat all as optional. */
function requirementsOf(raw: unknown): { due: string[]; deadline: number | null } {
  const r = (raw ?? {}) as {
    currently_due?: unknown;
    past_due?: unknown;
    current_deadline?: unknown;
  };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // past_due first: those are the ones already blocking, and an operator reading
  // a truncated list should see the urgent items.
  const due = Array.from(new Set([...list(r.past_due), ...list(r.currently_due)]));
  return { due, deadline: typeof r.current_deadline === "number" ? r.current_deadline : null };
}

export async function getConnectStatus(
  companyId: string,
  organizationId: string,
): Promise<ConnectStatus> {
  const company = await loadCompany(companyId, organizationId);
  const accountId: string | null = company.stripe_connected_account_id ?? null;
  const { due, deadline } = requirementsOf(company.stripe_requirements);
  const chargesEnabled = company.stripe_charges_enabled === true;

  return {
    companyId: company.id,
    companyName: company.name ?? null,
    connected: Boolean(accountId),
    accountId,
    mode: (company.stripe_mode as "test" | "live" | null) ?? null,
    chargesEnabled,
    payoutsEnabled: company.stripe_payouts_enabled === true,
    detailsSubmitted: company.stripe_details_submitted === true,
    requirementsDue: due,
    requirementsDeadline: deadline,
    // Connected and chargeable are different states: onboarding can finish with
    // charges_enabled still false while Stripe verifies. Only this one means a
    // customer can pay.
    readyToCharge: Boolean(accountId) && chargesEnabled,
    updatedAt: company.stripe_connect_updated_at ?? null,
  };
}

/**
 * Where Stripe sends the tenant after onboarding.
 *
 * `refreshUrl` points at our own API route, not at a screen: Account Links are
 * single-use and expire in minutes, and Stripe fetches refresh_url expecting to
 * be redirected onward to a NEW link. Pointing it at a page would leave the
 * tenant staring at a settings screen with no way forward.
 */
export function onboardingUrls(
  organizationId: string,
  companyId: string,
): { returnUrl: string; refreshUrl: string } {
  const base = (process.env.APP_BASE_URL ?? getQuotesConfig().publicBaseUrl).replace(/\/$/, "");
  const c = encodeURIComponent(companyId);
  return {
    returnUrl: `${base}/settings?company=${c}&connected=1`,
    refreshUrl:
      `${base}/api/organizations/${encodeURIComponent(organizationId)}` +
      `/companies/${c}/stripe-connect/refresh`,
  };
}
