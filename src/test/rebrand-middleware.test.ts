// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { captureLegacyUsage } from "@/test/helpers/legacy-usage-capture";

// Everdoer rebrand PR 1: the dormant legacy-host 301 and old-host counting in src/middleware.ts.

const getUser = vi.fn(async () => ({ data: { user: null }, error: null }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

import { middleware } from "@/middleware";
import { isLegacyPagesHost, pagesLegacyHostsOf, pagesRewritePath } from "@/server/services/dfy/site-host";
import {
  isNextInternalOrAsset,
  LEGACY_APP_HOSTS,
  legacyHostRedirect,
  legacyPathSample,
  legacyRedirectOrigin,
} from "@/server/services/rebrand/legacy-hosts";

const ON = { EVERDOER_REDIRECT_LEGACY_HOSTS: "1", EVERDOER_APP_BASE_URL: "https://app.everdoer.com" };

function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  const host = new URL(url).host;
  return new NextRequest(url, { method: init.method ?? "GET", headers: { host, ...(init.headers ?? {}) } });
}

let capture: ReturnType<typeof captureLegacyUsage>;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "EVERDOER_REDIRECT_LEGACY_HOSTS",
  "EVERDOER_APP_BASE_URL",
  "PAGES_BASE_URL",
  "PAGES_LEGACY_HOSTS",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "MOBILE_APP_ORIGINS",
];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Supabase configured, so session refresh runs for pages that are not redirected.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "pk_test";
  getUser.mockClear();
  capture = captureLegacyUsage();
});

afterEach(() => {
  capture.restore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function switchOn(): void {
  process.env.EVERDOER_REDIRECT_LEGACY_HOSTS = ON.EVERDOER_REDIRECT_LEGACY_HOSTS;
  process.env.EVERDOER_APP_BASE_URL = ON.EVERDOER_APP_BASE_URL;
}

function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400;
}

describe("legacy-host redirect: dormant by default", () => {
  it("does not redirect with neither env var set", async () => {
    const res = await middleware(req("https://app.empirevu.com/quotes?x=1"));
    expect(isRedirect(res)).toBe(false);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("does not redirect with only EVERDOER_APP_BASE_URL set (renaming the env var can't start redirects)", async () => {
    process.env.EVERDOER_APP_BASE_URL = "https://app.everdoer.com";
    const res = await middleware(req("https://app.empirevu.com/quotes"));
    expect(isRedirect(res)).toBe(false);
  });

  it("does not redirect with only EVERDOER_REDIRECT_LEGACY_HOSTS set", async () => {
    process.env.EVERDOER_REDIRECT_LEGACY_HOSTS = "1";
    const res = await middleware(req("https://app.empirevu.com/quotes"));
    expect(isRedirect(res)).toBe(false);
  });

  it("does not redirect with an invalid base URL or one pointing at another old host", async () => {
    process.env.EVERDOER_REDIRECT_LEGACY_HOSTS = "1";
    process.env.EVERDOER_APP_BASE_URL = "not a url";
    expect(isRedirect(await middleware(req("https://app.empirevu.com/quotes")))).toBe(false);
    process.env.EVERDOER_APP_BASE_URL = "https://app.crankleads.com";
    expect(isRedirect(await middleware(req("https://app.empirevu.com/quotes")))).toBe(false);
    process.env.EVERDOER_APP_BASE_URL = "ftp://app.everdoer.com";
    expect(isRedirect(await middleware(req("https://app.empirevu.com/quotes")))).toBe(false);
  });

  it("flag values: only 1/true/yes switch it on", () => {
    expect(legacyRedirectOrigin({ ...ON, EVERDOER_REDIRECT_LEGACY_HOSTS: "0" })).toBeNull();
    expect(legacyRedirectOrigin({ ...ON, EVERDOER_REDIRECT_LEGACY_HOSTS: "" })).toBeNull();
    expect(legacyRedirectOrigin({ ...ON, EVERDOER_REDIRECT_LEGACY_HOSTS: "TRUE" })).toBe("https://app.everdoer.com");
    expect(legacyRedirectOrigin({ ...ON, EVERDOER_APP_BASE_URL: "https://app.everdoer.com/some/path/" })).toBe(
      "https://app.everdoer.com",
    );
  });
});

describe("legacy-host redirect: switched on", () => {
  beforeEach(switchOn);

  it.each(LEGACY_APP_HOSTS)("301s a page GET on %s to the same path + query", async (host) => {
    const res = await middleware(req(`https://${host}/q/abc123?pay=1&utm_source=sms`));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://app.everdoer.com/q/abc123?pay=1&utm_source=sms");
    expect(getUser).not.toHaveBeenCalled();
  });

  it("301s HEAD", async () => {
    const res = await middleware(req("https://app.crankleads.com/welcome/crankleads", { method: "HEAD" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://app.everdoer.com/welcome/crankleads");
  });

  it("301s the root and generated-site / review paths", async () => {
    expect((await middleware(req("https://app.empirevu.com/"))).headers.get("location")).toBe("https://app.everdoer.com/");
    expect((await middleware(req("https://app.empirevu.com/s/acme-snow"))).headers.get("location")).toBe(
      "https://app.everdoer.com/s/acme-snow",
    );
    expect((await middleware(req("https://app.empirevu.com/r/tok123"))).headers.get("location")).toBe(
      "https://app.everdoer.com/r/tok123",
    );
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("does not redirect %s", async (method) => {
    const res = await middleware(req("https://app.empirevu.com/quotes", { method }));
    expect(isRedirect(res)).toBe(false);
  });

  it.each([
    ["/api/public/forms/evpk_123", "API"],
    ["/api/intake", "lead intake"],
    ["/api/webhooks/stripe", "Stripe webhook"],
    ["/embed/v1.js", "embed script"],
    ["/embed/anything", "embed path"],
    ["/f/evpk_123", "hosted lead form"],
    ["/oauth/callback", "OAuth return (PKCE verifier in old origin)"],
    ["/oauth/callback/", "OAuth return, trailing slash"],
    ["/update-password", "password recovery"],
    ["/_next/static/chunks/main.js", "Next internals"],
    ["/assets/index-abc.js", "static asset"],
    ["/assets/index-abc.css", "static asset"],
    ["/manifest.webmanifest", "static file"],
    ["/robots.txt", "static file"],
  ])("never redirects %s (%s)", async (path) => {
    const res = await middleware(req(`https://app.empirevu.com${path}`));
    expect(isRedirect(res)).toBe(false);
  });

  it("never redirects a Supabase auth landing (?code= / ?token_hash=) on any page", async () => {
    expect(isRedirect(await middleware(req("https://app.empirevu.com/?code=abc")))).toBe(false);
    expect(isRedirect(await middleware(req("https://app.empirevu.com/onboarding?token_hash=abc&type=signup")))).toBe(false);
  });

  it("does not redirect when already on the target host", async () => {
    process.env.EVERDOER_APP_BASE_URL = "https://app.crankleads.com"; // refused (old host): no redirect anywhere
    expect(isRedirect(await middleware(req("https://app.crankleads.com/quotes")))).toBe(false);
    // Target on a legacy host is the only way "already on target" can arise for an old host.
    expect(
      legacyHostRedirect(
        { host: "app.everdoer.com", method: "GET", pathname: "/quotes", search: "" },
        { EVERDOER_REDIRECT_LEGACY_HOSTS: "1", EVERDOER_APP_BASE_URL: "https://app.everdoer.com" },
      ),
    ).toBeNull();
    process.env.EVERDOER_APP_BASE_URL = "https://app.everdoer.com";
    getUser.mockClear();
    const res = await middleware(req("https://app.everdoer.com/quotes"));
    expect(isRedirect(res)).toBe(false);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("never redirects api.empirevu.com, even page paths", async () => {
    for (const path of ["/", "/quotes", "/q/tok", "/api/intake", "/embed/v1.js"]) {
      expect(isRedirect(await middleware(req(`https://api.empirevu.com${path}`)))).toBe(false);
    }
  });

  it.each(["quotes.a1marinecare.ca", "quotes.a1marinestorage.ca", "localhost:3000", "app.everdoer.com"])(
    "never redirects %s",
    async (host) => {
      const res = await middleware(req(`https://${host}/q/tok123?x=1`));
      expect(isRedirect(res)).toBe(false);
    },
  );

  it("keeps the pages-host rewrite first", async () => {
    process.env.PAGES_BASE_URL = "https://pages.everdoer.com";
    process.env.PAGES_LEGACY_HOSTS = "pages.crankleads.com";
    const res = await middleware(req("https://pages.crankleads.com/acme-snow"));
    expect(res.headers.get("x-middleware-rewrite")).toBe("https://pages.crankleads.com/s/acme-snow");
    const fresh = await middleware(req("https://pages.everdoer.com/acme-snow"));
    expect(fresh.headers.get("x-middleware-rewrite")).toBe("https://pages.everdoer.com/s/acme-snow");
  });
});

describe("old hosts: CORS and session refresh unchanged", () => {
  beforeEach(switchOn);

  it("API CORS on an old host is the same as before (mobile origins only)", async () => {
    const pre = await middleware(
      req("https://app.empirevu.com/api/jobs", { method: "OPTIONS", headers: { origin: "capacitor://localhost" } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    const get = await middleware(req("https://app.empirevu.com/api/jobs", { headers: { origin: "capacitor://localhost" } }));
    expect(get.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    const foreign = await middleware(req("https://app.empirevu.com/api/jobs", { headers: { origin: "https://everdoer.com" } }));
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("non-redirected pages on an old host still refresh the session", async () => {
    await middleware(req("https://app.empirevu.com/oauth/callback?code=abc"));
    await middleware(req("https://app.empirevu.com/quotes", { method: "POST" }));
    expect(getUser).toHaveBeenCalledTimes(2);
  });
});

describe("old-host counting (on or off)", () => {
  it("counts page hits, /api|/embed|/f hits and every api.empirevu.com request, redirect off", async () => {
    await middleware(req("https://app.empirevu.com/q/0f3c9a7b2d1e4f5a6b7c8d9e?pay=1"));
    await middleware(req("https://app.empirevu.com/quotes"));
    await middleware(req("https://app.crankleads.com/welcome/crankleads?session_id=cs_test_123"));
    await middleware(req("https://app.empirevu.com/api/jobs"));
    await middleware(req("https://app.empirevu.com/embed/v1.js"));
    await middleware(req("https://app.crankleads.com/f/evpk_123"));
    await middleware(req("https://api.empirevu.com/api/intake", { method: "POST" }));
    await middleware(req("https://api.empirevu.com/api/retell/webhook", { method: "POST" }));
    // Not counted: new hosts, tenants, assets.
    await middleware(req("https://app.everdoer.com/quotes"));
    await middleware(req("https://quotes.a1marinecare.ca/q/tok"));
    await middleware(req("https://app.empirevu.com/assets/index-abc.js"));

    const rows = await capture.rows();
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(rows.every((r) => r.kind === "host")).toBe(true);
    expect(Object.keys(byKey).sort()).toEqual(
      ["api.empirevu.com", "app.crankleads.com", "app.crankleads.com/api", "app.empirevu.com", "app.empirevu.com/api"].sort(),
    );
    expect(byKey["app.empirevu.com"].count).toBe(2);
    expect(byKey["app.empirevu.com/api"]).toMatchObject({ count: 2, sample: null });
    expect(byKey["app.crankleads.com/api"]).toMatchObject({ count: 1, sample: null });
    expect(byKey["api.empirevu.com"].count).toBe(2);
    // Samples are paths only: never a query string or a token.
    for (const r of rows) {
      expect(r.sample ?? "").not.toContain("?");
      expect(r.sample ?? "").not.toContain("0f3c9a7b2d1e4f5a6b7c8d9e");
      expect(r.sample ?? "").not.toContain("cs_test_123");
    }
  });

  it("counts the same way when the redirect is on", async () => {
    switchOn();
    await middleware(req("https://app.empirevu.com/quotes"));
    await middleware(req("https://app.empirevu.com/api/jobs"));
    const rows = await capture.rows();
    expect(rows.map((r) => r.key).sort()).toEqual(["app.empirevu.com", "app.empirevu.com/api"]);
  });

  it("counts a legacy pages host", async () => {
    process.env.PAGES_BASE_URL = "https://pages.everdoer.com";
    process.env.PAGES_LEGACY_HOSTS = "https://pages.crankleads.com";
    await middleware(req("https://pages.crankleads.com/acme-snow"));
    await middleware(req("https://pages.everdoer.com/acme-snow"));
    const rows = await capture.rows();
    expect(rows).toEqual([{ kind: "host", key: "pages.crankleads.com", sample: "/acme-snow", count: 1 }]);
  });
});

describe("helpers", () => {
  it("legacyPathSample masks ids and tokens after the first segment", () => {
    expect(legacyPathSample("/q/0f3c9a7b2d")).toBe("/q/:id");
    expect(legacyPathSample("/settings/billing")).toBe("/settings/billing");
    expect(legacyPathSample("/jobs/6b1e0b7e-4c1f-4d7e-9f1a-1c2b3c4d5e6f")).toBe("/jobs/:id");
    expect(legacyPathSample("/")).toBe("/");
  });

  it("isNextInternalOrAsset", () => {
    expect(isNextInternalOrAsset("/_next/data/x.json")).toBe(true);
    expect(isNextInternalOrAsset("/embed/v1.js")).toBe(true);
    expect(isNextInternalOrAsset("/quotes")).toBe(false);
    expect(isNextInternalOrAsset("/q/abc")).toBe(false);
  });

  it("PAGES_LEGACY_HOSTS: hosts or origins, never a platform app/API host", () => {
    expect(pagesLegacyHostsOf(" pages.crankleads.com, https://Pages.Old.example/ ,app.empirevu.com,api.everdoer.com,, ")).toEqual([
      "pages.crankleads.com",
      "pages.old.example",
    ]);
    expect(pagesRewritePath("app.empirevu.com", "/acme", undefined, "app.empirevu.com")).toBeNull();
    expect(pagesRewritePath("pages.crankleads.com", "/acme", undefined, "pages.crankleads.com")).toBe("/s/acme");
    expect(pagesRewritePath("pages.crankleads.com", "/api/public/forms/x", undefined, "pages.crankleads.com")).toBeNull();
    expect(isLegacyPagesHost("pages.everdoer.com", "https://pages.everdoer.com", "pages.everdoer.com")).toBe(false);
    expect(pagesRewritePath("pages.everdoer.com", "/acme", "https://pages.everdoer.com")).toBe("/s/acme");
  });

  it("only app.empirevu.com and app.crankleads.com are legacy APP hosts", () => {
    expect([...LEGACY_APP_HOSTS].sort()).toEqual(["app.crankleads.com", "app.empirevu.com"]);
  });
});
