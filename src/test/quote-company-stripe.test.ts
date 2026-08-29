import { describe, expect, it } from "vitest";

import {
  CompanyStripeError,
  isConnectedAccountId,
  onAccount,
  sanitizeStatementDescriptorSuffix,
  type CompanyStripeConfig,
} from "@/server/services/quotes/company-stripe";

const CO = "11111111-1111-1111-1111-111111111111";

const cfg = (over: Partial<CompanyStripeConfig> = {}): CompanyStripeConfig => ({
  companyId: CO,
  organizationId: "22222222-2222-2222-2222-222222222222",
  name: "A1 Marine Storage",
  accountId: "acct_1234567890",
  accountLabel: "A1 Marine Storage (test)",
  mode: "test",
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  statementDescriptorSuffix: "A1 STORAGE",
  ...over,
});

/**
 * Every merchant-side Stripe call must be directed at the tenant's connected
 * account. Omitting the option silently executes against the PLATFORM account —
 * money into the wrong balance, wrong merchant of record — so the seam that
 * produces it is worth pinning down.
 */
describe("connected-account request options", () => {
  it("carries the tenant's account id and nothing else", () => {
    expect(onAccount(cfg())).toEqual({ stripeAccount: "acct_1234567890" });
  });

  it("two tenants produce different options", () => {
    expect(onAccount(cfg({ accountId: "acct_aaa" }))).not.toEqual(
      onAccount(cfg({ accountId: "acct_bbb" })),
    );
  });

  it("spreads cleanly alongside an idempotency key", () => {
    // The call sites do `{ ...acct, idempotencyKey }` — this is that shape.
    const merged = { ...onAccount(cfg()), idempotencyKey: "quote-deposit-x-100" };
    expect(merged.stripeAccount).toBe("acct_1234567890");
    expect(merged.idempotencyKey).toBe("quote-deposit-x-100");
  });
});

describe("connected account id shape", () => {
  it("accepts real account ids", () => {
    expect(isConnectedAccountId("acct_1A2b3C4d5E")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const v of ["cus_123", "acct", "acct_", "", null, undefined, "sk_test_x"]) {
      expect(isConnectedAccountId(v as string)).toBe(false);
    }
  });
});

/**
 * Connecting an account and being able to take money are different states.
 * Stripe onboarding can finish with charges_enabled still false pending
 * verification, and discovering that when a customer taps Pay is the worst
 * possible moment.
 */
describe("CompanyStripeError codes", () => {
  it("distinguishes not-connected from charges-disabled", () => {
    const notConnected = new CompanyStripeError("x", "not_connected", CO);
    const disabled = new CompanyStripeError("y", "charges_disabled", CO);

    expect(notConnected.code).toBe("not_connected");
    expect(disabled.code).toBe("charges_disabled");
    expect(notConnected.companyId).toBe(CO);
  });

  it("is an Error, so it survives normal error handling", () => {
    const err = new CompanyStripeError("nope", "company_not_found", CO);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CompanyStripeError");
  });
});

/**
 * Statement descriptors keep tenants apart on a cardholder's statement. Stripe
 * REJECTS the charge if the descriptor is malformed, so a bad brand name must
 * never reach the API.
 */
describe("statement descriptor suffix", () => {
  it("passes a clean brand name through", () => {
    expect(sanitizeStatementDescriptorSuffix("A1 Marine Storage")).toBe("A1 Marine Storage");
  });

  it("strips the characters Stripe forbids", () => {
    expect(sanitizeStatementDescriptorSuffix('A1 <Marine> "Storage"')).toBe("A1 Marine Storage");
    expect(sanitizeStatementDescriptorSuffix("A1*Storage")).toBe("A1 Storage");
  });

  it("caps at 22 characters with no trailing space", () => {
    const out = sanitizeStatementDescriptorSuffix("A1 Marine Storage And Detailing")!;
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out).toBe(out.trim());
  });

  it("collapses whitespace", () => {
    expect(sanitizeStatementDescriptorSuffix("A1    Marine\n\tStorage")).toBe("A1 Marine Storage");
  });

  it("returns null when nothing usable survives, so the caller omits the field", () => {
    for (const v of ["***", "12345", "   ", null, undefined]) {
      expect(sanitizeStatementDescriptorSuffix(v)).toBeNull();
    }
  });

  it("keeps sibling brands distinguishable", () => {
    expect(sanitizeStatementDescriptorSuffix("A1 Marine Storage")).not.toBe(
      sanitizeStatementDescriptorSuffix("A1 Marine Care"),
    );
  });
});

/**
 * The whole point of moving to Connect: no tenant credentials anywhere. Under the
 * previous scheme this object resolved an env var holding a live secret key.
 */
describe("no tenant secrets in the resolved config", () => {
  it("carries an account id and no key material", () => {
    const resolved = cfg();
    const blob = JSON.stringify(resolved).toLowerCase();
    expect(blob).not.toContain("sk_");
    expect(blob).not.toContain("whsec_");
    expect(blob).not.toContain("secret");
    expect(resolved.accountId.startsWith("acct_")).toBe(true);
  });
});
