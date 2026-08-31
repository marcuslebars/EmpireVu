/**
 * Connect status derivation + org scoping. The state machine is the business
 * logic worth pinning: `charges_enabled` (not `details_submitted`) is what makes
 * a company "ready" — an account can finish onboarding and still be unable to
 * charge while Stripe verifies. And a read must never cross org boundaries.
 */
import { describe, expect, it } from "vitest";

import {
  getCompanyConnectStatus,
  listCompanyConnectStatus,
} from "@/server/services/quotes/connect";

interface Row {
  id: string;
  organization_id: string;
  name: string | null;
  stripe_connected_account_id: string | null;
  stripe_charges_enabled: boolean | null;
  stripe_payouts_enabled: boolean | null;
  stripe_details_submitted: boolean | null;
}

const ROWS: Row[] = [
  // org-1
  row("c-none", "org-1", "No Account Co", { account: null }),
  row("c-incomplete", "org-1", "Onboarding Co", {
    account: "acct_incomplete",
    charges: false,
    details: true, // details submitted but charges still off => NOT ready
  }),
  row("c-ready", "org-1", "Ready Co", {
    account: "acct_ready",
    charges: true,
    payouts: true,
    details: true,
  }),
  // org-2 (must never appear in org-1 reads)
  row("c-other", "org-2", "Other Org Co", { account: "acct_other", charges: true }),
];

function row(
  id: string,
  organization_id: string,
  name: string,
  opts: { account?: string | null; charges?: boolean; payouts?: boolean; details?: boolean },
): Row {
  return {
    id,
    name,
    organization_id,
    stripe_charges_enabled: opts.charges ?? false,
    stripe_connected_account_id: opts.account ?? null,
    stripe_details_submitted: opts.details ?? false,
    stripe_payouts_enabled: opts.payouts ?? false,
  };
}

/** In-memory PostgREST-ish builder covering .select().eq()*.order()/.maybeSingle(). */
function makeSupabase(rows: Row[]) {
  return {
    from() {
      const filters: Record<string, string> = {};
      const builder = {
        select: () => builder,
        eq: (col: string, val: string) => {
          filters[col] = val;
          return builder;
        },
        order: () =>
          Promise.resolve({ data: rows.filter((r) => matches(r, filters)), error: null }),
        maybeSingle: () =>
          Promise.resolve({ data: rows.find((r) => matches(r, filters)) ?? null, error: null }),
      };
      return builder;
    },
  };
}

function matches(row: Row, filters: Record<string, string>): boolean {
  return Object.entries(filters).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (rows: Row[]) => makeSupabase(rows) as any;

describe("listCompanyConnectStatus", () => {
  it("returns only the org's companies, each with the right derived state", async () => {
    const result = await listCompanyConnectStatus(db(ROWS), "org-1");
    const byId = Object.fromEntries(result.map((r) => [r.companyId, r]));

    expect(result).toHaveLength(3); // org-2's company is excluded
    expect(byId["c-other"]).toBeUndefined();

    expect(byId["c-none"].state).toBe("not_connected");
    expect(byId["c-none"].connected).toBe(false);

    expect(byId["c-incomplete"].state).toBe("onboarding_incomplete");
    expect(byId["c-incomplete"].connected).toBe(true);
    expect(byId["c-incomplete"].chargesEnabled).toBe(false);

    expect(byId["c-ready"].state).toBe("ready");
    expect(byId["c-ready"].chargesEnabled).toBe(true);
    expect(byId["c-ready"].payoutsEnabled).toBe(true);
    expect(byId["c-ready"].accountId).toBe("acct_ready");
  });
});

describe("getCompanyConnectStatus (the routes' authorization gate)", () => {
  it("returns the status for a company in the org", async () => {
    const s = await getCompanyConnectStatus(db(ROWS), "org-1", "c-ready");
    expect(s?.state).toBe("ready");
  });

  it("returns null for a company that belongs to another org", async () => {
    const s = await getCompanyConnectStatus(db(ROWS), "org-1", "c-other");
    expect(s).toBeNull();
  });

  it("returns null for an unknown company id", async () => {
    const s = await getCompanyConnectStatus(db(ROWS), "org-1", "nope");
    expect(s).toBeNull();
  });
});
