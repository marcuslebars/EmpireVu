import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connect onboarding decides where a business's money lands, so the tests here
 * are about the two ways that goes wrong quietly: attaching an account to a
 * company you do not own, and creating a second Stripe account for a company
 * that already has one.
 */

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
  organization_id: string;
  stripe_connected_account_id: string | null;
  stripe_mode?: string | null;
  stripe_charges_enabled?: boolean;
  stripe_payouts_enabled?: boolean;
  stripe_details_submitted?: boolean;
  stripe_requirements?: unknown;
  stripe_connect_updated_at?: string | null;
  brand_reply_email?: string | null;
  brand_website_url?: string | null;
}

let rows: Row[] = [];
const updates: Array<Record<string, unknown>> = [];

/** Minimal supabase-js chain: .from().select().eq().eq().maybeSingle() etc. */
function fakeDb() {
  return {
    from() {
      const filters: Array<[string, unknown]> = [];
      let pending: Record<string, unknown> | null = null;

      const match = () =>
        rows.filter((r) => filters.every(([col, val]) => (r as unknown as Record<string, unknown>)[col] === val));

      const chain: Record<string, unknown> = {
        select: () => chain,
        update(values: Record<string, unknown>) {
          pending = values;
          return chain;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return chain;
        },
        maybeSingle() {
          if (pending) {
            const hits = match();
            updates.push({ ...pending, __matched: hits.length });
            hits.forEach((r) => Object.assign(r, pending));
            return Promise.resolve({ data: hits[0] ?? null, error: null });
          }
          return Promise.resolve({ data: match()[0] ?? null, error: null });
        },
        then(resolve: (v: unknown) => unknown) {
          // `await db.from(...).update(...).eq(...)` with no .select()
          if (pending) {
            const hits = match();
            updates.push({ ...pending, __matched: hits.length });
            hits.forEach((r) => Object.assign(r, pending));
          }
          return Promise.resolve(resolve({ data: null, error: null }));
        },
      };
      return chain;
    },
  };
}

const accountsCreate = vi.fn();
const accountLinksCreate = vi.fn();

vi.mock("@/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => fakeDb(),
}));

vi.mock("@/server/services/quotes/company-stripe", () => ({
  getPlatformStripe: () => ({
    accounts: { create: accountsCreate, retrieve: vi.fn() },
    accountLinks: { create: accountLinksCreate },
  }),
}));

const {
  ConnectError,
  getConnectStatus,
  onboardingUrls,
  startConnectOnboarding,
} = await import("@/server/services/quotes/connect");

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const COMPANY = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  rows = [
    {
      id: COMPANY,
      name: "A1 Marine Storage",
      organization_id: ORG,
      stripe_connected_account_id: null,
      brand_reply_email: "quotes@a1marinestorage.ca",
      brand_website_url: "https://a1marinestorage.ca",
    },
  ];
  updates.length = 0;
  accountsCreate.mockReset();
  accountLinksCreate.mockReset();
  accountsCreate.mockResolvedValue({ id: "acct_TEST" });
  accountLinksCreate.mockResolvedValue({ url: "https://connect.stripe.com/setup/x", expires_at: 1 });
});

const urls = { returnUrl: "https://app/return", refreshUrl: "https://app/refresh" };

// ── Org scoping ──────────────────────────────────────────────────────────────

/**
 * These run on the ADMIN client, so RLS is not standing in the way. A company id
 * is a bearer token for someone else's payouts unless the org is checked here.
 */
describe("a company can only be reached from its own organization", () => {
  it("refuses onboarding for a company in another org", async () => {
    await expect(startConnectOnboarding(COMPANY, OTHER_ORG, urls)).rejects.toThrow(ConnectError);
    // The important part: no Stripe account was created for someone else's business.
    expect(accountsCreate).not.toHaveBeenCalled();
  });

  it("reports not_found rather than forbidden, so the id is not confirmed", async () => {
    await expect(startConnectOnboarding(COMPANY, OTHER_ORG, urls)).rejects.toMatchObject({
      code: "company_not_found",
    });
  });

  it("refuses to read status across orgs", async () => {
    await expect(getConnectStatus(COMPANY, OTHER_ORG)).rejects.toMatchObject({
      code: "company_not_found",
    });
  });

  it("allows the owning organization", async () => {
    const link = await startConnectOnboarding(COMPANY, ORG, urls);
    expect(link.accountId).toBe("acct_TEST");
  });
});

// ── Account creation ─────────────────────────────────────────────────────────

describe("account creation", () => {
  it("persists the account id before minting the link", async () => {
    await startConnectOnboarding(COMPANY, ORG, urls);
    // A Stripe account cannot be deleted once it has activity, so an id we
    // created but failed to record becomes permanent clutter — and the next
    // attempt would create a second one.
    expect(updates.some((u) => u.stripe_connected_account_id === "acct_TEST")).toBe(true);
  });

  it("reuses an existing account instead of creating a second", async () => {
    rows[0].stripe_connected_account_id = "acct_EXISTING";
    const link = await startConnectOnboarding(COMPANY, ORG, urls);
    expect(accountsCreate).not.toHaveBeenCalled();
    expect(link.accountId).toBe("acct_EXISTING");
  });

  it("keys creation by company so a double-click cannot make two accounts", async () => {
    await startConnectOnboarding(COMPANY, ORG, urls);
    expect(accountsCreate.mock.calls[0][1]).toMatchObject({
      idempotencyKey: `connect-account-${COMPANY}`,
    });
  });

  it("creates a standard account carrying its company and org metadata", async () => {
    await startConnectOnboarding(COMPANY, ORG, urls);
    expect(accountsCreate.mock.calls[0][0]).toMatchObject({
      type: "standard",
      metadata: { company_id: COMPANY, organization_id: ORG },
    });
  });
});

// ── Status ───────────────────────────────────────────────────────────────────

describe("status distinguishes connected from chargeable", () => {
  it("is not ready to charge while Stripe is still verifying", async () => {
    rows[0].stripe_connected_account_id = "acct_X";
    rows[0].stripe_details_submitted = true;
    rows[0].stripe_charges_enabled = false;

    const s = await getConnectStatus(COMPANY, ORG);
    // Onboarding can COMPLETE with charges still disabled. Conflating the two is
    // how a customer ends up at a card screen that cannot take their money.
    expect(s.connected).toBe(true);
    expect(s.detailsSubmitted).toBe(true);
    expect(s.readyToCharge).toBe(false);
  });

  it("is ready only when an account exists and charges are enabled", async () => {
    rows[0].stripe_connected_account_id = "acct_X";
    rows[0].stripe_charges_enabled = true;
    expect((await getConnectStatus(COMPANY, ORG)).readyToCharge).toBe(true);
  });

  it("is not ready when charges are somehow enabled with no account", async () => {
    rows[0].stripe_charges_enabled = true;
    const s = await getConnectStatus(COMPANY, ORG);
    expect(s.connected).toBe(false);
    expect(s.readyToCharge).toBe(false);
  });

  it("surfaces past_due before currently_due, without duplicates", async () => {
    rows[0].stripe_connected_account_id = "acct_X";
    rows[0].stripe_requirements = {
      currently_due: ["external_account", "tos_acceptance.date"],
      past_due: ["external_account"],
      current_deadline: 1789000000,
    };
    const s = await getConnectStatus(COMPANY, ORG);
    expect(s.requirementsDue).toEqual(["external_account", "tos_acceptance.date"]);
    expect(s.requirementsDeadline).toBe(1789000000);
  });

  it("survives requirements being absent, null, or the wrong shape", async () => {
    rows[0].stripe_connected_account_id = "acct_X";
    for (const shape of [undefined, null, {}, { currently_due: null }, { currently_due: "nope" }, []]) {
      rows[0].stripe_requirements = shape;
      const s = await getConnectStatus(COMPANY, ORG);
      expect(s.requirementsDue).toEqual([]);
      expect(s.requirementsDeadline).toBeNull();
    }
  });
});

// ── Return URLs ──────────────────────────────────────────────────────────────

describe("onboarding return urls", () => {
  it("sends refresh at the API route, not a screen", async () => {
    process.env.APP_BASE_URL = "https://empirevu.com";
    const { refreshUrl, returnUrl } = onboardingUrls(ORG, COMPANY);
    // Stripe fetches refresh_url expecting a redirect onward to a NEW link. A
    // page there would strand the tenant with no way to continue.
    expect(refreshUrl).toBe(
      `https://empirevu.com/api/organizations/${ORG}/companies/${COMPANY}/stripe-connect/refresh`,
    );
    expect(returnUrl).toContain("/settings?company=");
    delete process.env.APP_BASE_URL;
  });
});
