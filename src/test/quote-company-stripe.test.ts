import { afterEach, describe, expect, it } from "vitest";

import {
  MERCHANT_ENV_PATTERN,
  CompanyStripeError,
  assertKeyMatchesMode,
  readMerchantEnv,
  sanitizeStatementDescriptorSuffix,
} from "@/server/services/quotes/company-stripe";

const CO = "11111111-1111-1111-1111-111111111111";
const touched: string[] = [];

function setEnv(name: string, value: string) {
  process.env[name] = value;
  touched.push(name);
}

afterEach(() => {
  for (const n of touched.splice(0)) delete process.env[n];
});

describe("merchant env allowlist", () => {
  it("accepts STRIPE_MERCHANT_-prefixed names", () => {
    for (const n of ["STRIPE_MERCHANT_A1MS_SECRET_KEY", "STRIPE_MERCHANT_X", "STRIPE_MERCHANT_ORG_2_HOOK"]) {
      expect(MERCHANT_ENV_PATTERN.test(n)).toBe(true);
    }
  });

  it("rejects anything outside the prefix", () => {
    for (const n of [
      "STRIPE_SECRET_KEY", //          the PLATFORM key — must never be reachable
      "SUPABASE_SERVICE_ROLE_KEY", //  the crown jewels
      "PATH",
      "stripe_merchant_lower",
      "STRIPE_MERCHANTX", //           prefix must be exact
      "",
    ]) {
      expect(MERCHANT_ENV_PATTERN.test(n)).toBe(false);
    }
  });

  /**
   * Org settings are admin-editable, so the env var NAME is attacker-influenced
   * input. Without the allowlist this function is an arbitrary env reader.
   */
  it("refuses to read a non-allowlisted var even when it exists", () => {
    setEnv("SUPABASE_SERVICE_ROLE_KEY", "super-secret-value");

    expect(() => readMerchantEnv("SUPABASE_SERVICE_ROLE_KEY", CO)).toThrow(CompanyStripeError);
    try {
      readMerchantEnv("SUPABASE_SERVICE_ROLE_KEY", CO);
    } catch (err) {
      const e = err as CompanyStripeError;
      expect(e.code).toBe("invalid_env_name");
      // The secret's VALUE must never appear in the error.
      expect(e.message).not.toContain("super-secret-value");
    }
  });

  it("cannot be used to reach the platform Stripe key", () => {
    setEnv("STRIPE_SECRET_KEY", "sk_live_platform_key");
    expect(() => readMerchantEnv("STRIPE_SECRET_KEY", CO)).toThrow(/not an allowed merchant secret name/);
  });

  it("reads an allowlisted var that is set", () => {
    setEnv("STRIPE_MERCHANT_A1MS_SECRET_KEY", "sk_test_abc123");
    expect(readMerchantEnv("STRIPE_MERCHANT_A1MS_SECRET_KEY", CO)).toBe("sk_test_abc123");
  });

  it("throws a named, actionable error when an allowlisted var is missing", () => {
    try {
      readMerchantEnv("STRIPE_MERCHANT_MISSING_KEY", CO);
      throw new Error("expected a throw");
    } catch (err) {
      const e = err as CompanyStripeError;
      expect(e.code).toBe("missing_secret");
      // The name is safe to surface and is what the operator needs to fix it.
      expect(e.message).toContain("STRIPE_MERCHANT_MISSING_KEY");
      expect(e.companyId).toBe(CO);
    }
  });

  it("treats an empty or whitespace value as missing", () => {
    setEnv("STRIPE_MERCHANT_EMPTY", "   ");
    expect(() => readMerchantEnv("STRIPE_MERCHANT_EMPTY", CO)).toThrow(/is not set/);
  });

  it("can return null instead of throwing when the caller says it is optional", () => {
    expect(readMerchantEnv("STRIPE_MERCHANT_ABSENT", CO, { required: false })).toBeNull();
  });
});

describe("key/mode mismatch guard", () => {
  it("accepts a matching pair", () => {
    expect(() => assertKeyMatchesMode("sk_test_abc", "test")).not.toThrow();
    expect(() => assertKeyMatchesMode("sk_live_abc", "live")).not.toThrow();
    expect(() => assertKeyMatchesMode("rk_test_abc", "test")).not.toThrow();
  });

  it("catches a live key in a brand marked test", () => {
    expect(() => assertKeyMatchesMode("sk_live_abc", "test")).toThrow(/test mode/);
  });

  /** The expensive direction: a test key in a live org means payments silently don't happen. */
  it("catches a test key in a brand marked live", () => {
    expect(() => assertKeyMatchesMode("sk_test_abc", "live")).toThrow(/live mode/);
  });

  it("is a no-op when the brand has no declared mode", () => {
    expect(() => assertKeyMatchesMode("sk_live_abc", null)).not.toThrow();
  });
});


/**
 * Statement descriptors are how a cardholder tells one A1 brand from another when
 * the brands share a Stripe account. Stripe REJECTS the charge if the descriptor
 * is malformed, so a bad brand name must never reach the API.
 */
describe("statement descriptor suffix", () => {
  it("passes a clean brand name through", () => {
    expect(sanitizeStatementDescriptorSuffix("A1 Marine Storage")).toBe("A1 Marine Storage");
  });

  it("strips the characters Stripe forbids", () => {
    // < > \ " ' * are rejected outright by Stripe.
    expect(sanitizeStatementDescriptorSuffix('A1 <Marine> "Storage"')).toBe("A1 Marine Storage");
    expect(sanitizeStatementDescriptorSuffix("A1*Storage")).toBe("A1 Storage");
  });

  it("caps at 22 characters and does not leave a trailing space", () => {
    const out = sanitizeStatementDescriptorSuffix("A1 Marine Storage And Detailing")!;
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out).toBe(out.trim());
  });

  it("collapses whitespace rather than emitting runs of spaces", () => {
    expect(sanitizeStatementDescriptorSuffix("A1    Marine\n\tStorage")).toBe("A1 Marine Storage");
  });

  it("returns null when nothing usable survives, so the caller omits the field", () => {
    // Stripe requires at least one letter; better to fall back to the account
    // default than to fail the payment.
    expect(sanitizeStatementDescriptorSuffix("***")).toBeNull();
    expect(sanitizeStatementDescriptorSuffix("12345")).toBeNull();
    expect(sanitizeStatementDescriptorSuffix("   ")).toBeNull();
    expect(sanitizeStatementDescriptorSuffix(null)).toBeNull();
    expect(sanitizeStatementDescriptorSuffix(undefined)).toBeNull();
  });

  it("keeps sibling brands distinguishable", () => {
    const storage = sanitizeStatementDescriptorSuffix("A1 Marine Storage");
    const care = sanitizeStatementDescriptorSuffix("A1 Marine Care");
    expect(storage).not.toBe(care);
    expect(storage).toBeTruthy();
    expect(care).toBeTruthy();
  });
});
