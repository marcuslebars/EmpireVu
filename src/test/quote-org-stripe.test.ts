import { afterEach, describe, expect, it } from "vitest";

import {
  MERCHANT_ENV_PATTERN,
  OrgStripeError,
  assertKeyMatchesMode,
  readMerchantEnv,
} from "@/server/services/quotes/org-stripe";

const ORG = "11111111-1111-1111-1111-111111111111";
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

    expect(() => readMerchantEnv("SUPABASE_SERVICE_ROLE_KEY", ORG)).toThrow(OrgStripeError);
    try {
      readMerchantEnv("SUPABASE_SERVICE_ROLE_KEY", ORG);
    } catch (err) {
      const e = err as OrgStripeError;
      expect(e.code).toBe("invalid_env_name");
      // The secret's VALUE must never appear in the error.
      expect(e.message).not.toContain("super-secret-value");
    }
  });

  it("cannot be used to reach the platform Stripe key", () => {
    setEnv("STRIPE_SECRET_KEY", "sk_live_platform_key");
    expect(() => readMerchantEnv("STRIPE_SECRET_KEY", ORG)).toThrow(/not an allowed merchant secret name/);
  });

  it("reads an allowlisted var that is set", () => {
    setEnv("STRIPE_MERCHANT_A1MS_SECRET_KEY", "sk_test_abc123");
    expect(readMerchantEnv("STRIPE_MERCHANT_A1MS_SECRET_KEY", ORG)).toBe("sk_test_abc123");
  });

  it("throws a named, actionable error when an allowlisted var is missing", () => {
    try {
      readMerchantEnv("STRIPE_MERCHANT_MISSING_KEY", ORG);
      throw new Error("expected a throw");
    } catch (err) {
      const e = err as OrgStripeError;
      expect(e.code).toBe("missing_secret");
      // The name is safe to surface and is what the operator needs to fix it.
      expect(e.message).toContain("STRIPE_MERCHANT_MISSING_KEY");
      expect(e.organizationId).toBe(ORG);
    }
  });

  it("treats an empty or whitespace value as missing", () => {
    setEnv("STRIPE_MERCHANT_EMPTY", "   ");
    expect(() => readMerchantEnv("STRIPE_MERCHANT_EMPTY", ORG)).toThrow(/is not set/);
  });

  it("can return null instead of throwing when the caller says it is optional", () => {
    expect(readMerchantEnv("STRIPE_MERCHANT_ABSENT", ORG, { required: false })).toBeNull();
  });
});

describe("key/mode mismatch guard", () => {
  it("accepts a matching pair", () => {
    expect(() => assertKeyMatchesMode("sk_test_abc", "test")).not.toThrow();
    expect(() => assertKeyMatchesMode("sk_live_abc", "live")).not.toThrow();
    expect(() => assertKeyMatchesMode("rk_test_abc", "test")).not.toThrow();
  });

  it("catches a live key in an org marked test", () => {
    expect(() => assertKeyMatchesMode("sk_live_abc", "test")).toThrow(/test mode/);
  });

  /** The expensive direction: a test key in a live org means payments silently don't happen. */
  it("catches a test key in an org marked live", () => {
    expect(() => assertKeyMatchesMode("sk_test_abc", "live")).toThrow(/live mode/);
  });

  it("is a no-op when the org has no declared mode", () => {
    expect(() => assertKeyMatchesMode("sk_live_abc", null)).not.toThrow();
  });
});
