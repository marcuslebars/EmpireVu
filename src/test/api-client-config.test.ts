/**
 * The shared API client defaults to same-origin + cookie (the web SPA) and can be pointed
 * at an absolute origin with a Bearer token (the native mobile app).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApiClient, fetchAutomationImpact, fetchInbox, resolveApiUrl } from "@/lib/api-client";

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

afterEach(() => {
  configureApiClient({ baseUrl: "", getAccessToken: null });
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("api-client configuration", () => {
  it("keeps relative paths and sends no Authorization header by default", async () => {
    vi.stubGlobal("fetch", fetchMock);
    await fetchInbox("org-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/organizations/org-1/inbox?limit=100");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("prefixes the configured origin and attaches the access token", async () => {
    vi.stubGlobal("fetch", fetchMock);
    configureApiClient({ baseUrl: "https://empirevu.com/", getAccessToken: async () => "jwt-abc" });

    await fetchInbox("org-1", { companyId: "co-9" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://empirevu.com/api/organizations/org-1/inbox?companyId=co-9&limit=100");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-abc");
  });

  // The automation-impact tile read org-wide totals under every company scope: the route
  // and the SQL filtered by company, but the client never sent one.
  it("scopes automation impact to a company, and to the org without one", async () => {
    vi.stubGlobal("fetch", fetchMock);

    await fetchAutomationImpact("org-1", { companyId: "co-9" });
    await fetchAutomationImpact("org-1");

    // buildUrl resolves against the page origin, so compare path + query only.
    const urls = fetchMock.mock.calls.map((call) => {
      const url = new URL((call as unknown as [string])[0], "http://origin.test");
      return `${url.pathname}${url.search}`;
    });
    expect(urls).toEqual([
      "/api/organizations/org-1/ui/dashboard/automation-impact?companyId=co-9",
      "/api/organizations/org-1/ui/dashboard/automation-impact",
    ]);
  });

  it("leaves absolute URLs untouched", () => {
    configureApiClient({ baseUrl: "https://empirevu.com" });
    expect(resolveApiUrl("https://other.example.com/api/x")).toBe("https://other.example.com/api/x");
    expect(resolveApiUrl("/api/x")).toBe("https://empirevu.com/api/x");
  });
});
