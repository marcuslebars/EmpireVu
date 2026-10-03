import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import { quoteLinkForCompanyId, quotePublicBaseUrlForCompanyId } from "@/server/services/quotes/public-url";

const ORIGINAL = process.env.QUOTE_PUBLIC_BASE_URL;

function fakeDb(row: Record<string, unknown> | null, fail = false) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (fail) throw new Error("db down");
            return { data: row };
          },
        }),
      }),
    }),
  };
}

describe("per-company quote links", () => {
  beforeEach(() => {
    process.env.QUOTE_PUBLIC_BASE_URL = "https://quotes.a1marinestorage.ca";
  });
  afterEach(() => {
    process.env.QUOTE_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("uses the company's own quote domain when it has one", () => {
    expect(quotePublicBaseUrlFor({ quote_public_base_url: "https://quotes.a1marinecare.ca" })).toBe("https://quotes.a1marinecare.ca");
    expect(quotePublicBaseUrlFor({ quote_public_base_url: "https://quotes.a1marinecare.ca/" })).toBe("https://quotes.a1marinecare.ca");
  });

  it("falls back to the platform domain when the company has none, or the column doesn't exist yet", () => {
    expect(quotePublicBaseUrlFor({ quote_public_base_url: null })).toBe("https://quotes.a1marinestorage.ca");
    expect(quotePublicBaseUrlFor({ quote_public_base_url: "  " })).toBe("https://quotes.a1marinestorage.ca");
    expect(quotePublicBaseUrlFor({ name: "Storage" } as never)).toBe("https://quotes.a1marinestorage.ca");
    expect(quotePublicBaseUrlFor(null)).toBe("https://quotes.a1marinestorage.ca");
  });

  it("builds the link by company id, and never fails a send over a lookup error", async () => {
    expect(await quoteLinkForCompanyId("c1", "tok", fakeDb({ quote_public_base_url: "https://quotes.a1marinecare.ca" }))).toBe(
      "https://quotes.a1marinecare.ca/q/tok",
    );
    expect(await quotePublicBaseUrlForCompanyId("c1", fakeDb(null))).toBe("https://quotes.a1marinestorage.ca");
    expect(await quotePublicBaseUrlForCompanyId("c1", fakeDb(null, true))).toBe("https://quotes.a1marinestorage.ca");
    expect(await quotePublicBaseUrlForCompanyId(null, fakeDb({ quote_public_base_url: "https://x.example" }))).toBe(
      "https://quotes.a1marinestorage.ca",
    );
  });
});
