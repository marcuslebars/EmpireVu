/**
 * New self-serve tenants must land on a time-boxed TRIAL, not the `internal`
 * (billing-exempt) house default — otherwise every signup gets the whole product
 * free. This covers the trial-field logic and that createOrganization writes it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newOrgTrialFields } from "@/server/services/billing/env";
import { createOrganization } from "@/server/services/organizations";

describe("newOrgTrialFields", () => {
  beforeEach(() => {
    delete process.env.BILLING_TRIAL_PLAN;
    delete process.env.BILLING_TRIAL_DAYS;
  });
  afterEach(() => {
    delete process.env.BILLING_TRIAL_PLAN;
    delete process.env.BILLING_TRIAL_DAYS;
  });

  it("defaults to a 14-day Operate trial and is never internal", () => {
    const f = newOrgTrialFields(new Date("2026-08-04T00:00:00.000Z"));
    expect(f.plan).toBe("operate");
    expect(f.plan).not.toBe("internal");
    expect(f.subscription_status).toBe("trialing");
    expect(f.trial_ends_at).toBe(new Date("2026-08-18T00:00:00.000Z").toISOString());
  });

  it("honors BILLING_TRIAL_PLAN and BILLING_TRIAL_DAYS", () => {
    process.env.BILLING_TRIAL_PLAN = "launch";
    process.env.BILLING_TRIAL_DAYS = "30";
    const f = newOrgTrialFields(new Date("2026-08-04T00:00:00.000Z"));
    expect(f.plan).toBe("launch");
    expect(f.trial_ends_at).toBe(new Date("2026-09-03T00:00:00.000Z").toISOString());
  });

  it("falls back on an unpurchasable plan or non-positive days", () => {
    process.env.BILLING_TRIAL_PLAN = "internal"; // not a purchasable plan
    process.env.BILLING_TRIAL_DAYS = "0";
    const f = newOrgTrialFields(new Date("2026-08-04T00:00:00.000Z"));
    expect(f.plan).toBe("operate");
    expect(f.trial_ends_at).toBe(new Date("2026-08-18T00:00:00.000Z").toISOString());
  });
});

describe("createOrganization — provisions a trial, not an exempt org", () => {
  it("writes plan/subscription_status/trial_ends_at on the new org (never internal)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let orgInsert: any = null;
    const from = (table: string) => {
      if (table === "organizations") {
        return {
          // slug pre-check
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          // create
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          insert: (payload: any) => {
            orgInsert = payload;
            return { select: () => ({ single: async () => ({ data: { id: "org-new", ...payload }, error: null }) }) };
          },
        };
      }
      if (table === "organization_memberships") return { insert: async () => ({ error: null }) };
      if (table === "profiles") return { update: () => ({ eq: async () => ({ error: null }) }) };
      throw new Error(`unexpected table ${table}`);
    };

    const org = await createOrganization(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from } as any,
      "user-1",
      "profile-1",
      { name: "Harbour Detailing" },
    );

    expect(org.id).toBe("org-new");
    expect(orgInsert.plan).toBe("operate");
    expect(orgInsert.plan).not.toBe("internal");
    expect(orgInsert.subscription_status).toBe("trialing");
    expect(typeof orgInsert.trial_ends_at).toBe("string");
  });
});
