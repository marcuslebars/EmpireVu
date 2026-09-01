/**
 * The stronger connect gating ported onto the live implementation:
 *  - only owner/admin may manage a payment account;
 *  - Stripe's dotted requirement keys surface as words an operator can act on.
 */
import { describe, expect, it } from "vitest";

import {
  assertCanManagePayments,
  humanizeRequirement,
  listCompanyConnectStatus,
} from "@/server/services/quotes/connect";

describe("assertCanManagePayments", () => {
  it("allows owner and admin", () => {
    expect(() => assertCanManagePayments("owner")).not.toThrow();
    expect(() => assertCanManagePayments("admin")).not.toThrow();
  });
  it("blocks a plain member", () => {
    expect(() => assertCanManagePayments("member")).toThrow(/owner or admin/);
  });
});

describe("humanizeRequirement", () => {
  it("maps known Stripe keys to plain words", () => {
    expect(humanizeRequirement("external_account")).toBe("A bank account for payouts");
    expect(humanizeRequirement("business_profile.url")).toBe("A business website");
  });
  it("falls back to readable words for unmapped keys (never a raw dotted path)", () => {
    expect(humanizeRequirement("individual.first_name")).toBe("first name");
    expect(humanizeRequirement("some_unknown_key")).toBe("some unknown key");
  });
});

describe("listCompanyConnectStatus — requirement translation", () => {
  it("surfaces translated, de-duped requirements and derives the incomplete state", async () => {
    const rows = [
      {
        id: "c1",
        name: "Harbour Detailing",
        stripe_connected_account_id: "acct_1",
        stripe_charges_enabled: false,
        stripe_payouts_enabled: false,
        stripe_details_submitted: true,
        stripe_requirements: {
          currently_due: ["external_account", "business_profile.url"],
          past_due: ["external_account"],
        },
      },
    ];
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null }) }) }),
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [status] = await listCompanyConnectStatus(supabase as any, "org-1");
    expect(status.state).toBe("onboarding_incomplete");
    expect(status.requirements).toEqual(["A bank account for payouts", "A business website"]);
  });
});
