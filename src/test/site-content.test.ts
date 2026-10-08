import { describe, expect, it } from "vitest";

import { roofingCompany, snowCompany, sparseCompany } from "@/server/services/dfy/__fixtures__/sample-sites";
import {
  buildSiteFacts,
  chooseSiteMode,
  formatCents,
  isValidSlug,
  parseHours,
  screenSiteCopy,
  servicePrice,
  siteSlugBase,
  slugCandidates,
  templateSiteCopy,
  unsupportedClaims,
  type SiteCopyModelOutput,
} from "@/server/services/dfy/site-content";

const snow = buildSiteFacts(snowCompany);

describe("site facts", () => {
  it("prices come only from catalog cents; unpriced services have no price", () => {
    const byKey = Object.fromEntries(snow.services.map((s) => [s.key, s.priceText]));
    expect(byKey).toEqual({
      seasonal_residential: "$549",
      per_push_residential: "$65 / visit",
      salting_driveway: "$35 / application",
      walkway_shovelling: "$25 / visit",
      commercial_lot: null,
      roof_snow: null,
      spring_cleanup: "$225",
    });
    expect(buildSiteFacts(roofingCompany).services.every((s) => s.priceText === null)).toBe(true);
  });

  it("states shapes it can't price honestly as 'From <minimum>' or a quote", () => {
    const base = { service_key: "x", label: "X", description: null, unit_label: "ft" };
    expect(servicePrice({ ...base, pricing_type: "tiered_by_measure", rate_cents: 1200, minimum_cents: 0 }).priceText).toBeNull();
    expect(servicePrice({ ...base, pricing_type: "per_measure_banded", rate_cents: 1200, minimum_cents: 30000 }).priceText).toBe("From $300");
    expect(servicePrice({ ...base, pricing_type: "per_measure", rate_cents: 250, minimum_cents: 15000 })).toEqual({ priceText: "$2.50 / ft", priceNote: "Minimum $150" });
    expect(formatCents(125000)).toBe("$1,250");
  });

  it("only shows a rating when both rating and count are present", () => {
    expect(snow.rating).toBe(4.8);
    const noCount = buildSiteFacts({ ...snowCompany, company: { ...snowCompany.company, google_review_count: null } });
    expect(noCount.rating).toBeNull();
    expect(noCount.reviewCount).toBeNull();
  });

  it("groups per-day hours and builds schema.org specs; passes summaries through", () => {
    expect(snow.hoursLines).toEqual(["Mon–Fri: 7am–6pm", "Sat: 8am–2pm", "Sun: Closed"]);
    expect(snow.openingHours[0]).toEqual({ days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "07:00", closes: "18:00" });
    expect(parseHours({ summary: "Mon–Fri 7am–5pm" })).toEqual({ lines: ["Mon–Fri 7am–5pm"], specs: [] });
    expect(parseHours({ weekdayText: ["Monday: 8 AM–5 PM"] }).lines).toEqual(["Monday: 8 AM–5 PM"]);
    expect(parseHours(null)).toEqual({ lines: [], specs: [] });
  });

  it("reads the enrichment's Google periods (day 0 = Sunday) as per-day lines, not one run-on summary", () => {
    const enriched = {
      summary: "Monday: 7:00 AM – 6:00 PM; Tuesday: 7:00 AM – 6:00 PM; Wednesday: 7:00 AM – 6:00 PM; Thursday: 7:00 AM – 6:00 PM; Friday: 7:00 AM – 6:00 PM; Saturday: 8:00 AM – 12:00 PM; Sunday: Closed",
      periods: [1, 2, 3, 4, 5].map((day) => ({ day, open: "07:00", close: "18:00" })).concat([{ day: 6, open: "08:00", close: "12:00" }]),
    };
    const parsed = parseHours(enriched);
    expect(parsed.lines).toEqual(["Mon–Fri: 7am–6pm", "Sat: 8am–12pm", "Sun: Closed"]);
    expect(parsed.specs).toEqual([
      { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "07:00", closes: "18:00" },
      { days: ["Saturday"], opens: "08:00", closes: "12:00" },
    ]);
    // Unreadable periods → the summary, as before.
    expect(parseHours({ summary: "Mon–Fri 7am–5pm", periods: [{ day: "x" }] }).lines).toEqual(["Mon–Fri 7am–5pm"]);
  });

  it("rejects non-https logos and unsafe review links", () => {
    const f = buildSiteFacts({ ...snowCompany, company: { ...snowCompany.company, brand_logo_url: "javascript:alert(1)", brand_review_url: "http://x.test" } });
    expect(f.logoUrl).toBeNull();
    expect(f.reviewUrl).toBeNull();
  });
});

describe("mode + slug", () => {
  it("full when there's no website, price_page when there is one", () => {
    expect(chooseSiteMode(null)).toBe("full");
    expect(chooseSiteMode("   ")).toBe("full");
    expect(chooseSiteMode("kawartharidgeroofing.ca")).toBe("price_page");
    expect(chooseSiteMode("https://example.com")).toBe("price_page");
  });

  it("makes URL-safe slugs and avoids reserved words", () => {
    expect(siteSlugBase("Côté Déneigement & Fils Inc.")).toBe("cote-deneigement-and-fils");
    expect(siteSlugBase("API")).toBe("api-co");
    expect(siteSlugBase("!!!")).toBe("business");
    const long = siteSlugBase("A".repeat(30) + " " + "B".repeat(30) + " Landscaping and Snow Removal Services");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(isValidSlug(long)).toBe(true);
    expect(slugCandidates("acme", 3)).toEqual(["acme", "acme-2", "acme-3"]);
  });
});

describe("template copy", () => {
  it("full mode: trade + area headline, call + quote subhead, 3–5 FAQs", () => {
    const copy = templateSiteCopy(snow, "full");
    expect(copy.headline).toBe("Snow removal and property maintenance in Barrie, Innisfil and Oro-Medonte");
    expect(copy.subhead).toContain("Call (705) 555-0142");
    expect(copy.subhead).toContain("book a time online");
    expect(copy.faqs.length).toBeGreaterThanOrEqual(3);
    expect(copy.faqs.length).toBeLessThanOrEqual(5);
    expect(copy.about).toContain("We plow, salt and shovel");
  });

  it("price_page mode focuses on services", () => {
    const copy = templateSiteCopy(buildSiteFacts(roofingCompany), "price_page");
    expect(copy.headline).toBe("Roofing in Peterborough and the Kawarthas");
    const priced = templateSiteCopy(snow, "price_page");
    expect(priced.headline).toBe("Our services and prices");
  });

  it("a sparse company still gets usable copy with no invented facts", () => {
    const facts = buildSiteFacts(sparseCompany);
    const copy = templateSiteCopy(facts, "full");
    expect(copy.headline).toBe("J. Tremblay Contracting");
    expect(copy.faqs.length).toBeGreaterThanOrEqual(3);
    const all = [copy.headline, copy.subhead, copy.about, ...copy.faqs.flatMap((f) => [f.question, f.answer])].join(" ");
    expect(unsupportedClaims(all, facts)).toEqual([]);
  });

  it("template copy for every fixture passes the claim screen", () => {
    for (const fixture of [snowCompany, roofingCompany, sparseCompany]) {
      const facts = buildSiteFacts(fixture);
      for (const mode of ["full", "price_page"] as const) {
        const copy = templateSiteCopy(facts, mode);
        const all = [copy.headline, copy.subhead, copy.about, ...Object.values(copy.serviceBlurbs), ...copy.faqs.flatMap((f) => [f.question, f.answer])].join(" ");
        expect(unsupportedClaims(all, facts)).toEqual([]);
      }
    }
  });
});

describe("screening model copy", () => {
  const good: SiteCopyModelOutput = {
    headline: "Snow removal in Barrie",
    subhead: "Plowing and salting for driveways. Call (705) 555-0142 or ask for a quote.",
    about: "Northshore Snow & Property plows, salts and shovels driveways and small lots across south Barrie.",
    serviceBlurbs: [{ key: "roof_snow", blurb: "Heavy snow taken off your roof." }, { key: "made_up", blurb: "Not a real service." }],
    faqs: [
      { question: "What areas do you serve?", answer: "Barrie, Innisfil and Oro-Medonte." },
      { question: "Can I book online?", answer: "Yes, use the Book online button." },
      { question: "How do I get a quote?", answer: "Use the form or call us." },
    ],
  };

  it("keeps clean copy and drops blurbs for services we don't have", () => {
    const out = screenSiteCopy(good, snow, "full");
    expect(out.source).toBe("ai");
    expect(out.copy.headline).toBe("Snow removal in Barrie");
    expect(out.copy.serviceBlurbs.made_up).toBeUndefined();
    expect(out.copy.serviceBlurbs.roof_snow).toBe("Heavy snow taken off your roof.");
  });

  it("replaces fields with invented prices, years, licences, guarantees or review quotes", () => {
    const bad: SiteCopyModelOutput = {
      ...good,
      headline: "Licensed and insured snow removal since 2009",
      about: "With 15 years of experience we guarantee a clear driveway. Customers say \"best plow guys in town, every time\".",
      faqs: [
        { question: "How much is plowing?", answer: "Just $49 per visit." },
        ...good.faqs,
      ],
    };
    const out = screenSiteCopy(bad, snow, "full");
    const template = templateSiteCopy(snow, "full");
    expect(out.source).toBe("mixed");
    expect(out.copy.headline).toBe(template.headline);
    expect(out.copy.about).toBe(template.about);
    expect(out.copy.faqs.some((f) => f.answer.includes("$49"))).toBe(false);
    expect(out.notes.length).toBeGreaterThanOrEqual(3);
  });

  it("allows a claim the owner's own facts make", () => {
    const facts = buildSiteFacts({ ...snowCompany, company: { ...snowCompany.company, profile: { about: "Fully insured, family-owned since 2009." } } });
    expect(unsupportedClaims("We are fully insured and family-owned since 2009.", facts)).toEqual([]);
  });

  it("uses Canadian spelling", () => {
    const out = screenSiteCopy({ ...good, about: "We help every neighbor keep their favorite driveway clear across south Barrie." }, snow, "full");
    expect(out.copy.about).toBe("We help every neighbour keep their favourite driveway clear across south Barrie.");
  });
});
