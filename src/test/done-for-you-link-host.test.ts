import { afterEach, describe, expect, it } from "vitest";

import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { quotePublicBaseUrlForCompanyId } from "@/server/services/quotes/public-url";
import { createFakeDb } from "@/test/helpers/fake-supabase";

describe("customer link host for CrankLeads companies", () => {
  afterEach(() => {
    delete process.env.QUOTE_PUBLIC_BASE_URL_CRANKLEADS;
    delete process.env.QUOTE_PUBLIC_BASE_URL;
    delete process.env.CRANKLEADS_APP_BASE_URL;
  });

  it("CrankLeads orgs default to the CrankLeads app domain when no override is set", () => {
    process.env.QUOTE_PUBLIC_BASE_URL = "https://app.empirevu.com";
    process.env.CRANKLEADS_APP_BASE_URL = "https://app.crankleads.com";
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://app.crankleads.com");
    expect(quotePublicBaseUrlFor({ platform_brand: "empirevu" })).toBe("https://app.empirevu.com");
  });

  it("company override → QUOTE_PUBLIC_BASE_URL_CRANKLEADS (CrankLeads orgs) → the platform default", () => {
    process.env.QUOTE_PUBLIC_BASE_URL = "https://app.empirevu.com";
    process.env.QUOTE_PUBLIC_BASE_URL_CRANKLEADS = "https://go.example-neutral.ca";
    expect(quotePublicBaseUrlFor({ quote_public_base_url: "https://quotes.northshore.ca", platform_brand: "crankleads" })).toBe("https://quotes.northshore.ca");
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://go.example-neutral.ca");
    expect(quotePublicBaseUrlFor({ platform_brand: "empirevu" })).toBe("https://app.empirevu.com");
    delete process.env.QUOTE_PUBLIC_BASE_URL_CRANKLEADS;
    expect(quotePublicBaseUrlFor({ platform_brand: "crankleads" })).toBe("https://app.empirevu.com");
  });

  it("by company id: reads the org's brand (crankleads_tier counts too)", async () => {
    process.env.QUOTE_PUBLIC_BASE_URL = "https://app.empirevu.com";
    process.env.QUOTE_PUBLIC_BASE_URL_CRANKLEADS = "https://go.example-neutral.ca";
    const db = createFakeDb({
      companies: [
        { id: "co-1", organization_id: "org-1", quote_public_base_url: null },
        { id: "co-2", organization_id: "org-2", quote_public_base_url: null },
      ],
      organizations: [
        { id: "org-1", platform_brand: null, crankleads_tier: "catch" },
        { id: "org-2", platform_brand: "empirevu", crankleads_tier: null },
      ],
    });
    expect(await quotePublicBaseUrlForCompanyId("co-1", db.client)).toBe("https://go.example-neutral.ca");
    expect(await quotePublicBaseUrlForCompanyId("co-2", db.client)).toBe("https://app.empirevu.com");
  });
});
