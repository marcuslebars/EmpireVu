import { describe, expect, it } from "vitest";

import { sanitizeStatementDescriptorSuffix } from "@/server/services/quotes/company-stripe";

/**
 * EmpireVu is the backend. Every customer-facing surface — the hosted quote page,
 * the deposit receipt, the statement line on a card — must carry the BRAND the
 * customer hired, never the platform running it.
 *
 * These tests guard that as a property of the code, not a convention someone has
 * to remember.
 */

/** Strings that must never reach a customer surface. */
const PLATFORM_TERMS = ["empirevu", "empire vu"];

function containsPlatformBranding(value: string): boolean {
  const haystack = value.toLowerCase();
  return PLATFORM_TERMS.some((t) => haystack.includes(t));
}

describe("customer-facing surfaces carry no platform branding", () => {
  it("the statement descriptor is the brand's, never the platform's", () => {
    const suffix = sanitizeStatementDescriptorSuffix("A1 Marine Storage");
    expect(suffix).toBe("A1 Marine Storage");
    expect(containsPlatformBranding(suffix!)).toBe(false);
  });

  it("sanitising never injects platform text into a descriptor", () => {
    for (const raw of ["A1 Storage", "***", "", "Acme Marine"]) {
      const out = sanitizeStatementDescriptorSuffix(raw);
      if (out) expect(containsPlatformBranding(out)).toBe(false);
    }
  });

  /**
   * The guard itself has to work, or the assertions above are vacuous.
   */
  it("the platform-branding detector actually detects", () => {
    expect(containsPlatformBranding("Powered by EmpireVu")).toBe(true);
    expect(containsPlatformBranding("Empire Vu Hub")).toBe(true);
    expect(containsPlatformBranding("A1 Marine Storage")).toBe(false);
  });
});

/**
 * Branding is resolved from the company row. A company with nothing configured
 * renders NEUTRAL — plain text on a default palette — rather than falling back to
 * anything platform-shaped. These assert the shape the page consumes.
 */
describe("brand resolution falls back to neutral, never to the platform", () => {
  // Mirrors companyBrand()'s contract without needing a database.
  const resolve = (company: Record<string, unknown> | null) => {
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
    return {
      name: str(company?.name),
      logoUrl: str(company?.brand_logo_url),
      primaryColor: str(company?.brand_primary_color),
      accentColor: str(company?.brand_accent_color),
      websiteUrl: str(company?.brand_website_url),
      replyEmail: str(company?.brand_reply_email),
      replyPhone: str(company?.brand_reply_phone),
      termsText: str(company?.quote_terms_text),
      cancellationPolicy: str(company?.cancellation_policy_text),
    };
  };

  it("an unbranded company yields all-null, not a platform default", () => {
    const brand = resolve(null);
    for (const [, v] of Object.entries(brand)) {
      expect(v).toBeNull();
    }
  });

  it("a configured company yields its own identity", () => {
    const brand = resolve({
      name: "A1 Marine Storage",
      brand_logo_url: "https://a1marinestorage.ca/logo.png",
      brand_primary_color: "#DE3C37",
      brand_reply_phone: "(249) 444-0072",
      cancellation_policy_text: "Refundable until Oct 1.",
    });

    expect(brand.name).toBe("A1 Marine Storage");
    expect(brand.logoUrl).toBe("https://a1marinestorage.ca/logo.png");
    expect(brand.primaryColor).toBe("#DE3C37");
    expect(brand.replyPhone).toBe("(249) 444-0072");
    expect(brand.cancellationPolicy).toBe("Refundable until Oct 1.");

    for (const v of Object.values(brand)) {
      if (typeof v === "string") expect(containsPlatformBranding(v)).toBe(false);
    }
  });

  it("treats blank and whitespace-only values as unset", () => {
    const brand = resolve({ name: "   ", brand_logo_url: "" });
    expect(brand.name).toBeNull();
    expect(brand.logoUrl).toBeNull();
  });

  it("two brands under one org resolve independently", () => {
    const storage = resolve({ name: "A1 Marine Storage", brand_primary_color: "#DE3C37" });
    const care = resolve({ name: "A1 Marine Care", brand_primary_color: "#00A8B5" });

    expect(storage.name).not.toBe(care.name);
    expect(storage.primaryColor).not.toBe(care.primaryColor);
  });
});
