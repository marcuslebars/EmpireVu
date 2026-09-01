import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/public-routes";

/**
 * Supabase fires INITIAL_SESSION with a null session for every visitor who is
 * not signed in. The auth listener treated that identically to SIGNED_OUT and
 * navigated to /signin — so a customer opening their quote link was shown a
 * sign-in form for a product they have never heard of:
 *
 *   [AuthContext] Auth state changed: INITIAL_SESSION
 *   [SignInPageWrapper] Route matched: /signin
 *
 * On these routes the token in the URL is the credential; an account is not.
 * The real authorization boundary is server-side in the API routes.
 */
describe("routes a signed-out visitor must be able to reach", () => {
  it("keeps a customer on their quote", () => {
    expect(isPublicPath("/q/d1120ee3cce10b2fdf17e15e5353b043")).toBe(true);
  });

  it("keeps a customer on a public booking page", () => {
    expect(isPublicPath("/book/a1000000-0000-4000-8000-000000000003")).toBe(true);
  });

  it("keeps an invitee on their invitation", () => {
    // This page prompts for sign-in itself, when and if it needs to.
    expect(isPublicPath("/invite/abc123")).toBe(true);
  });
});

describe("everything else still redirects", () => {
  it("does not exempt the app itself", () => {
    for (const p of ["/", "/quotes", "/settings", "/settings/payments", "/crm", "/calendar"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("is not fooled by a public segment appearing later in the path", () => {
    // A protected page must not become public because of its name.
    expect(isPublicPath("/settings/q/thing")).toBe(false);
    expect(isPublicPath("/internal/book/x")).toBe(false);
  });

  it("does not match a prefix that merely starts with the same letters", () => {
    // "/quotes" is the operator's admin list and must stay protected, even
    // though it begins with "/q".
    expect(isPublicPath("/quotes")).toBe(false);
    expect(isPublicPath("/bookings")).toBe(false);
  });
});
