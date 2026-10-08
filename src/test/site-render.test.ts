import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

let db: FakeDb;
vi.mock("@/server/supabase/admin", () => ({ createSupabaseAdminClient: () => db.client }));

import { GET as siteGET } from "@/app/s/[slug]/route";
import { middleware } from "@/middleware";
import { roofingCompany, snowCompany } from "@/server/services/dfy/__fixtures__/sample-sites";
import {
  buildSiteFacts,
  chooseSiteMode,
  factsUsed,
  templateSiteCopy,
  SITE_CONTENT_VERSION,
  type SiteContent,
  type SiteFactsInput,
} from "@/server/services/dfy/site-content";
import { pagesRewritePath } from "@/server/services/dfy/site-host";
import { buildJsonLd, renderSitePage } from "@/server/services/dfy/site-render";
import { siteUrl } from "@/server/services/dfy/site-url";

function contentFor(input: SiteFactsInput, patch: Partial<SiteContent> = {}): SiteContent {
  const facts = buildSiteFacts(input);
  const mode = chooseSiteMode(input.company.website);
  return {
    version: SITE_CONTENT_VERSION,
    mode,
    facts,
    factsUsed: factsUsed(facts),
    copy: templateSiteCopy(facts, mode),
    copySource: "template",
    copyNotes: [],
    edits: {},
    settings: { showPrices: true },
    generatedAt: "2026-10-08T12:00:00.000Z",
    ...patch,
  };
}

const opts = { url: "https://pages.crankleads.com/northshore", formKey: "evpk_0123456789abcdef0123456789abcdef", bookingUrl: null, turnstileSiteKey: null, creditUrl: "https://crankleads.com" };

afterEach(() => {
  delete process.env.PAGES_BASE_URL;
});

describe("renderer escaping", () => {
  const evil = '<script>alert("x")</script>';
  const hostile: SiteFactsInput = {
    ...snowCompany,
    company: {
      ...snowCompany.company,
      name: `Evil ${evil} & Co`,
      service_area: `<img src=x onerror=alert(1)>`,
      brand_logo_url: "javascript:alert(1)",
      brand_primary_color: "red;}</style><script>alert(1)</script>",
      profile: { about: `</script><script>alert(2)</script>`, highlights: [`"><svg onload=alert(3)>`] },
    },
    catalog: [{ service_key: "k", label: `<b onclick=x>Plow</b>`, description: `<iframe src=//evil>`, pricing_type: "flat", rate_cents: 1000, minimum_cents: 0, unit_label: null }],
  };

  it("escapes every company / owner / model string, in text, attributes and JSON-LD", () => {
    const content = contentFor(hostile, { edits: { headline: `<h1 onmouseover=alert(9)>hi` }, copy: { ...templateSiteCopy(buildSiteFacts(hostile), "full"), faqs: [{ question: "<q>", answer: `"><script>alert(4)</script>` }] } });
    const html = renderSitePage(content, { ...opts, url: 'https://pages.crankleads.com/x"><script>' });
    // The only <script> tags are ours: JSON-LD and the form script.
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script type="application/ld+json">', "<script>"]);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<iframe/);
    expect(html).not.toMatch(/<svg onload/);
    expect(html).not.toMatch(/<b onclick/);
    expect(html).not.toMatch(/<h1 onmouseover/);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("red;}");
    expect(html).toContain("Evil &lt;script&gt;");
    // JSON-LD can't break out of its script element.
    const ld = html.slice(html.indexOf('<script type="application/ld+json">'));
    const ldBody = ld.slice(ld.indexOf(">") + 1, ld.indexOf("</script>"));
    expect(ldBody).not.toContain("<");
    expect(JSON.parse(ldBody).name).toBe(`Evil ${evil} & Co`);
  });
});

describe("page content", () => {
  it("shows catalog prices and 'Get a quote' for unpriced services, and hides prices when turned off", () => {
    const html = renderSitePage(contentFor(snowCompany), opts);
    expect(html).toContain("$549");
    expect(html).toContain("$65<span class=\"unit\"> / visit</span>");
    expect((html.match(/data-service=/g) ?? []).length).toBe(2);
    const hidden = renderSitePage(contentFor(snowCompany, { settings: { showPrices: false } }), opts);
    expect(hidden).not.toContain("$549");
    expect((hidden.match(/data-service=/g) ?? []).length).toBe(7);
  });

  it("never shows a dollar amount that isn't a catalog price", () => {
    const html = renderSitePage(contentFor(snowCompany), opts);
    const amounts = new Set((html.match(/\$[\d,]+(\.\d+)?/g) ?? []).map((a) => a));
    expect([...amounts].sort()).toEqual(["$225", "$25", "$35", "$549", "$65"].sort());
  });

  it("price_page mode links back to the main site and has no 'How it works'", () => {
    const html = renderSitePage(contentFor(roofingCompany), opts);
    expect(html).toContain("Visit our main site");
    expect(html).toContain('href="https://kawartharidgeroofing.ca/"');
    expect(html).not.toContain("How it works");
  });

  it("posts the quote form to the public form API with honeypot + timing fields", () => {
    const html = renderSitePage(contentFor(snowCompany), opts);
    expect(html).toContain('data-endpoint="/api/public/forms/evpk_0123456789abcdef0123456789abcdef"');
    expect(html).toContain('name="website"');
    expect(html).toContain("formStartedAt");
    expect(html).not.toContain('class="cf-turnstile"');
    expect(renderSitePage(contentFor(snowCompany), { ...opts, turnstileSiteKey: "0xSITE" })).toContain('data-sitekey="0xSITE"');
  });

  it("no form key → call block instead of a form; no EmpireVu anywhere", () => {
    const html = renderSitePage(contentFor(snowCompany), { ...opts, formKey: null });
    expect(html).not.toContain("quote-form");
    expect(html).toContain('href="tel:+17055550142"');
    expect(html.toLowerCase()).not.toContain("empirevu");
  });
});

describe("JSON-LD", () => {
  it("is the trade's LocalBusiness subtype with contact, area, hours and sameAs — and no aggregateRating", () => {
    const ld = buildJsonLd(contentFor(snowCompany), { url: "https://pages.crankleads.com/northshore" });
    expect(ld).toMatchObject({
      "@context": "https://schema.org",
      "@type": "HomeAndConstructionBusiness",
      name: "Northshore Snow & Property",
      telephone: "+17055550142",
      areaServed: "Barrie, Innisfil and Oro-Medonte",
      url: "https://pages.crankleads.com/northshore",
      sameAs: ["https://www.google.com/maps/place/?q=place_id:ChIJ-sample-northshore"],
    });
    expect(ld.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "07:00", closes: "18:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Saturday"], opens: "08:00", closes: "14:00" },
    ]);
    expect(ld).not.toHaveProperty("aggregateRating");
    expect(JSON.stringify(ld)).not.toContain("ratingValue");
    const roof = buildJsonLd(contentFor(roofingCompany), { url: "u" });
    expect(roof["@type"]).toBe("RoofingContractor");
    expect(roof.sameAs).toEqual(["https://kawartharidgeroofing.ca/"]);
    expect(roof).not.toHaveProperty("openingHoursSpecification");
  });
});

describe("public route", () => {
  function seed(status: string) {
    db = createFakeDb({
      company_sites: [{ id: "s1", organization_id: "o1", company_id: "c1", slug: "northshore", status, content: contentFor(snowCompany), updated_at: "2026-10-08T00:00:00Z" }],
      public_form_keys: [{ organization_id: "o1", company_id: "c1", public_key: "evpk_0123456789abcdef0123456789abcdef", form_type: "quote", active: true }],
      companies: [{ id: "c1", organization_id: "o1", online_booking_settings: { enabled: false }, quote_public_base_url: null }],
    });
  }
  const call = (slug: string, headers: Record<string, string> = {}) =>
    siteGET(new Request(`http://app.test/s/${slug}`, { headers }), { params: { slug } }) as unknown as Promise<Response>;

  it("renders a published site with cache headers + ETag (304 on revalidate)", async () => {
    seed("published");
    const res = await call("northshore");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("s-maxage=60");
    const html = await res.text();
    expect(html).toContain("Northshore Snow &amp; Property");
    const etag = res.headers.get("etag")!;
    const again = await call("northshore", { "if-none-match": etag });
    expect(again.status).toBe(304);
  });

  it("draft, unpublished and unknown slugs are a neutral 404", async () => {
    for (const status of ["draft", "unpublished"]) {
      seed(status);
      const res = await call("northshore");
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain("This page isn't available");
      expect(html).not.toContain("Northshore");
    }
    seed("published");
    expect((await call("nope")).status).toBe(404);
    expect((await call("_")).status).toBe(404);
  });
});

describe("host-based routing", () => {
  const base = "https://pages.crankleads.com";
  it("rewrites /<slug> on the pages host only", () => {
    expect(pagesRewritePath("pages.crankleads.com", "/northshore", base)).toBe("/s/northshore");
    expect(pagesRewritePath("pages.crankleads.com", "/northshore/", base)).toBe("/s/northshore");
    expect(pagesRewritePath("PAGES.crankleads.com", "/northshore", base)).toBe("/s/northshore");
    expect(pagesRewritePath("pages.crankleads.com", "/", base)).toBe("/s/_");
    expect(pagesRewritePath("pages.crankleads.com", "/settings/billing", base)).toBe("/s/_");
    expect(pagesRewritePath("pages.crankleads.com", "/api/organizations/x", base)).toBe("/s/_");
    expect(pagesRewritePath("pages.crankleads.com", "/api/public/forms/evpk_1", base)).toBeNull();
    expect(pagesRewritePath("pages.crankleads.com", "/_next/static/x.js", base)).toBeNull();
    expect(pagesRewritePath("app.crankleads.com", "/northshore", base)).toBeNull();
    expect(pagesRewritePath("pages.crankleads.com", "/northshore", undefined)).toBeNull();
  });

  it("middleware rewrites pages-host requests to the /s route", async () => {
    process.env.PAGES_BASE_URL = base;
    const { NextRequest } = await import("next/server");
    const res = await middleware(new NextRequest("https://pages.crankleads.com/northshore", { headers: { host: "pages.crankleads.com" } }));
    expect(res.headers.get("x-middleware-rewrite")).toBe("https://pages.crankleads.com/s/northshore");
    const other = await middleware(new NextRequest("https://app.crankleads.com/s/northshore", { headers: { host: "app.crankleads.com" } }));
    expect(other.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("siteUrl uses PAGES_BASE_URL when set, else the brand's app origin", () => {
    process.env.PAGES_BASE_URL = "https://pages.crankleads.com/";
    expect(siteUrl("acme")).toBe("https://pages.crankleads.com/acme");
    delete process.env.PAGES_BASE_URL;
    vi.stubEnv("APP_BASE_URL", "https://app.empirevu.test");
    expect(siteUrl("acme", "empirevu")).toBe("https://app.empirevu.test/s/acme");
    vi.unstubAllEnvs();
  });
});
