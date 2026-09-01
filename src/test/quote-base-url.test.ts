import { describe, expect, it } from "vitest";

import { normalizeBaseUrl } from "@/server/services/quotes/config";

/**
 * QUOTE_PUBLIC_BASE_URL was set to "quotes.a1marinestorage.ca" — no scheme.
 *
 * Every customer link then became `<a href="quotes.a1marinestorage.ca/q/TOKEN">`,
 * which a browser resolves RELATIVE to the current page:
 *
 *   https://a1marinestorage.ca/quotes.a1marinestorage.ca/q/TOKEN   -> 404
 *
 * The same string goes into the quote email, where most clients will not
 * linkify it at all. Nothing errored anywhere: the quote was created, sent, and
 * unreachable. A customer clicking "Pay your deposit" landed on a 404.
 */
describe("a base URL without a scheme cannot produce relative links", () => {
  it("adds https to a bare hostname", () => {
    expect(normalizeBaseUrl("quotes.a1marinestorage.ca")).toBe("https://quotes.a1marinestorage.ca");
  });

  it("leaves an explicit scheme alone", () => {
    expect(normalizeBaseUrl("https://quotes.a1marinestorage.ca")).toBe("https://quotes.a1marinestorage.ca");
    expect(normalizeBaseUrl("http://staging.example")).toBe("http://staging.example");
  });

  it("keeps http for localhost, where https would not resolve", () => {
    expect(normalizeBaseUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBaseUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("assumes https for anything else — these links lead to a card form", () => {
    expect(normalizeBaseUrl("quotes.example.com")).toMatch(/^https:\/\//);
  });

  it("strips trailing slashes so the joined path has no double slash", () => {
    expect(normalizeBaseUrl("https://quotes.example.com/")).toBe("https://quotes.example.com");
    expect(normalizeBaseUrl("quotes.example.com///")).toBe("https://quotes.example.com");
  });

  it("falls back rather than emitting an empty base", () => {
    // An empty string would make every quote link the site root.
    expect(normalizeBaseUrl("   ")).toBe("http://localhost:3000");
  });

  it("produces a link a browser treats as absolute", () => {
    const base = normalizeBaseUrl("quotes.a1marinestorage.ca");
    const url = `${base}/q/abc123`;
    // The actual regression: this must not resolve against the current page.
    expect(new URL(url, "https://a1marinestorage.ca/calculator").href).toBe(
      "https://quotes.a1marinestorage.ca/q/abc123",
    );
  });
});
