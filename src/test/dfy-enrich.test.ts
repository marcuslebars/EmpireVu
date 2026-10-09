/**
 * Done-for-you enrichment (src/server/services/dfy/enrich.ts): price precedence (owner > site >
 * none, never invented), conservative name matching, owner-set fields kept, the end-to-end
 * enrichment against the in-memory PostgREST fake (Places / crawl / parser mocked), re-run
 * idempotency, and the sweep's claim (no double runs; a re-submit mid-run goes round again).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogDraft } from "@/server/ai/catalog-parser";
import type { CrawlResult } from "@/server/services/dfy/crawl";
import {
  enrichCompany,
  isEnrichmentDue,
  isSameService,
  MAX_ENRICH_ATTEMPTS,
  planCompanyUpdate,
  descriptionOnPage,
  listingMatchesCompany,
  ownerPriceMap,
  planServicePrices,
  priceStatedNearService,
  processPendingEnrichments,
  verifyDraftsAgainstPages,
  type EnrichDeps,
} from "@/server/services/dfy/enrich";
import type { PlaceDetails } from "@/server/services/dfy/places";
import type { IntakeAnswers } from "@/lib/setup-intake";

import { createFakeDb, type FakeDb } from "./helpers/fake-supabase";

type Row = Record<string, unknown>;

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "33333333-3333-4333-8333-333333333333";
const INSPECT = "55555555-5555-4555-8555-555555555555";
const REPAIR = "66666666-6666-4666-8666-666666666666";
const GUTTER = "88888888-8888-4888-8888-888888888888";
const PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4";

function catalogRow(id: string, label: string, pricing_type = "flat", extra: Row = {}) {
  return { id, organization_id: ORG, company_id: COMPANY, label, pricing_type, unit_label: null, rate_cents: 0, minimum_cents: 0, active: false, sort_order: 1, service_key: label.toLowerCase().replace(/\W+/g, "-"), ...extra };
}

const PLACE: PlaceDetails = {
  placeId: PLACE_ID,
  name: "Jane's Roofing",
  address: "12 Dunlop St W, Barrie, ON",
  locality: "Barrie",
  province: "ON",
  phoneNational: "(705) 555-0101",
  website: "https://janesroofing.ca/",
  hours: { summary: "Monday: 8:00 AM – 5:00 PM", periods: [{ day: 1, open: "08:00", close: "17:00" }] },
  rating: 4.8,
  reviewCount: 38,
  mapsUrl: "https://maps.google.com/?cid=1",
  primaryType: "Roofing contractor",
  reviewUrl: `https://search.google.com/local/writereview?placeid=${PLACE_ID}`,
};

const CRAWL: CrawlResult = {
  homepageUrl: "https://janesroofing.ca/",
  pages: [{ url: "https://janesroofing.ca/", text: "Roof inspection $150. Shingle repair from $9/sq ft. Skylight install $1,200. Chimney flashing." }],
  logoUrl: "https://janesroofing.ca/logo.png",
  description: "Family-run roofing in Barrie.",
  hoursText: "Mon - Fri 8am - 5pm",
  phones: ["+17055550101"],
  failures: [],
};

const DRAFTS: CatalogDraft[] = [
  { name: "Roof Inspections", description: null, pricingType: "flat", baseCents: 15000 },
  { name: "Shingle repair", description: null, pricingType: "per_measure", baseCents: 900 },
  { name: "Skylight installation", description: "Supply and install.", pricingType: "flat", baseCents: 120000 },
  { name: "Chimney flashing", description: null, pricingType: "flat", baseCents: null },
  { name: "Gutter cleaning", description: null, pricingType: "flat", baseCents: 20000 },
];

function answers(overrides: Partial<IntakeAnswers> = {}): IntakeAnswers {
  return {
    listing: { kind: "google", placeId: PLACE_ID, name: "Jane's Roofing", address: "12 Dunlop St W" },
    phone: { number: "+17055550199", kind: "cell", carrier: "rogers" },
    prices: { skipped: false, items: [{ id: REPAIR, label: "Shingle repair", priceCents: 1100 }] },
    ...overrides,
  };
}

// ── Pure planners ────────────────────────────────────────────────────────────

describe("service name matching (conservative)", () => {
  it("matches plural / punctuation / filler-word variants, not merely related services", () => {
    expect(isSameService("Roof inspection", "Roof Inspections")).toBe(true);
    expect(isSameService("Gutter cleaning", "Gutter-cleaning service")).toBe(true);
    expect(isSameService("Lawn mowing & trimming", "Lawn mowing and trimming")).toBe(true);
    expect(isSameService("Roof inspection", "Roof replacement")).toBe(false);
    expect(isSameService("Gutter cleaning", "Gutter installation")).toBe(false);
    expect(isSameService("Repair", "Shingle repair")).toBe(false);
    expect(isSameService("Snow removal", "Commercial snow removal")).toBe(false);
  });
});

describe("price precedence: owner > site > none (never invented)", () => {
  const catalog = [catalogRow(INSPECT, "Roof inspection"), catalogRow(REPAIR, "Shingle repair", "per_measure"), catalogRow(GUTTER, "Gutter cleaning", "per_measure")];

  it("owner price wins over the site's; site fills unpriced matches; unmatched priced flat services are added", () => {
    const plan = planServicePrices(catalog as never, answers(), DRAFTS);
    expect(plan.ops).toEqual([
      { kind: "price", id: REPAIR, label: "Shingle repair", cents: 1100, source: "owner" },
      { kind: "price", id: INSPECT, label: "Roof inspection", cents: 15000, source: "website" },
      { kind: "create", label: "Skylight installation", pricingType: "flat", unit: null, cents: 120000, description: "Supply and install.", source: "website" },
    ]);
    // Site says $200 flat for gutter cleaning, our item is priced per ft → not applied, flagged.
    expect(plan.notApplied).toEqual([{ label: "Gutter cleaning", cents: 20000, pricingType: "flat", reason: 'unit differs from "Gutter cleaning"' }]);
    // Listed without a price → nothing made up.
    expect(plan.unpricedOnSite).toEqual(["Chimney flashing"]);
  });

  it("no owner price and no site price → no price at all", () => {
    const plan = planServicePrices(catalog as never, answers({ prices: { skipped: true, items: [] } }), [
      { name: "Roof inspection", description: null, pricingType: "flat", baseCents: null },
    ]);
    expect(plan.ops).toEqual([]);
  });

  it("never overwrites a price that's already on the item (set by hand) with a site price", () => {
    const priced = [catalogRow(INSPECT, "Roof inspection", "flat", { rate_cents: 17500, active: true })];
    expect(planServicePrices(priced as never, null, DRAFTS.slice(0, 1)).ops).toEqual([]);
    // …but the owner's own intake answer does update it.
    const owner = answers({ prices: { skipped: false, items: [{ id: INSPECT, label: "Roof inspection", priceCents: 16000 }] } });
    expect(planServicePrices(priced as never, owner, DRAFTS.slice(0, 1)).ops).toEqual([
      { kind: "price", id: INSPECT, label: "Roof inspection", cents: 16000, source: "owner" },
    ]);
  });

  it("owner-added services: priced onto a same-named existing item, else created with their unit", () => {
    const owner = answers({
      prices: {
        skipped: false,
        items: [
          { label: "roof inspections", priceCents: 14000, unit: "flat" },
          { label: "Ice dam removal", priceCents: 25000, unit: "hour" },
        ],
      },
    });
    const plan = planServicePrices(catalog as never, owner, DRAFTS);
    expect(plan.ops[0]).toEqual({ kind: "price", id: INSPECT, label: "Roof inspection", cents: 14000, source: "owner" });
    expect(plan.ops[1]).toEqual({ kind: "create", label: "Ice dam removal", pricingType: "per_unit", unit: "hour", cents: 25000, description: null, source: "owner" });
    // The site's $150 for inspection doesn't override the owner's $140.
    expect(plan.ops.filter((o) => o.kind === "price" && o.id === INSPECT)).toHaveLength(1);
  });

  it("a per-unit site price for an unknown service isn't added (unit unclear)", () => {
    const plan = planServicePrices([], null, [{ name: "Eavestrough repair", description: null, pricingType: "per_measure", baseCents: 1200 }]);
    expect(plan.ops).toEqual([]);
    expect(plan.notApplied[0]).toMatchObject({ label: "Eavestrough repair", reason: "unit unclear" });
  });
});

describe("company facts: don't overwrite what the owner set", () => {
  const empty = {
    website: null,
    hours: null,
    service_area: null,
    brand_logo_url: null,
    brand_review_url: null,
    brand_reply_phone: null,
    owner_phone_e164: "+17055550101",
    google_place_id: null,
    profile: {},
  };

  it("fills empty fields and records each source", () => {
    const plan = planCompanyUpdate(empty as never, { answers: answers(), place: PLACE, crawl: CRAWL });
    expect(plan.patch).toMatchObject({
      website: "https://janesroofing.ca/",
      hours: { summary: "Monday: 8:00 AM – 5:00 PM", periods: [{ day: 1, open: "08:00", close: "17:00" }] },
      service_area: "Barrie and surrounding area",
      brand_logo_url: "https://janesroofing.ca/logo.png",
      brand_review_url: PLACE.reviewUrl,
      google_place_id: PLACE_ID,
      google_rating: 4.8,
      google_review_count: 38,
      business_phone_kind: "cell",
      business_phone_carrier: "rogers",
      owner_phone_e164: "+17055550199",
      owner_phone_verified_at: expect.any(String), // the buyer's own setup form: verified
      brand_reply_phone: "+17055550199",
      profile: {
        tagline: "Roofing contractor in Barrie",
        about: "Family-run roofing in Barrie.",
        source: {
          website: "google",
          hours: "google",
          service_area: "google",
          brand_logo_url: "website",
          brand_review_url: "google",
          brand_reply_phone: "intake",
          tagline: "google",
          about: "website",
        },
      },
    });
  });

  it("keeps values an owner set by hand; refreshes our own earlier values", () => {
    const handSet = {
      ...empty,
      service_area: "Simcoe County",
      brand_logo_url: "https://cdn/own-logo.png",
      hours: { summary: "By appointment" },
      profile: { about: "We are the best.", source: {} },
    };
    const plan = planCompanyUpdate(handSet as never, { answers: answers(), place: PLACE, crawl: CRAWL });
    expect(plan.patch.service_area).toBeUndefined();
    expect(plan.patch.brand_logo_url).toBeUndefined();
    expect(plan.patch.hours).toBeUndefined();
    expect((plan.patch.profile as Row).about).toBe("We are the best.");
    expect(plan.kept.map((k) => k.field).sort()).toEqual(["about", "brand_logo_url", "hours", "service_area"]);

    const ours = { ...empty, service_area: "Orillia and surrounding area", profile: { source: { service_area: "google" } } };
    expect(planCompanyUpdate(ours as never, { answers: null, place: PLACE, crawl: null }).patch.service_area).toBe("Barrie and surrounding area");
  });

  it("the buyer's typed website outranks Google's; a landline is never made the texting number", () => {
    const typed = answers({ listing: { kind: "website", url: "https://janes.ca/" }, phone: { number: "+17055550123", kind: "landline", carrier: "bell" } });
    const plan = planCompanyUpdate(empty as never, { answers: typed, place: null, crawl: null });
    expect(plan.patch.website).toBe("https://janes.ca/");
    expect(plan.patch.owner_phone_e164).toBeUndefined();
    expect(plan.patch.business_phone_kind).toBe("landline");
    const later = planCompanyUpdate({ ...empty, website: "https://janes.ca/", profile: { source: { website: "intake" } } } as never, {
      answers: null,
      place: PLACE,
      crawl: null,
    });
    expect(later.patch.website).toBeUndefined();
  });
});

// ── End to end against the fake DB ───────────────────────────────────────────

let db: FakeDb;
let admin: never;
let deps: Partial<EnrichDeps>;

function seed(intake: Row = {}) {
  db = createFakeDb(
    {
      organizations: [{ id: ORG, platform_brand: "crankleads" }],
      companies: [
        {
          id: COMPANY,
          organization_id: ORG,
          name: "Jane's Roofing",
          owner_phone_e164: "+17055550101",
          website: null,
          hours: null,
          service_area: null,
          brand_logo_url: null,
          brand_review_url: null,
          brand_reply_phone: null,
          profile: {},
        },
      ],
      service_catalog_items: [catalogRow(INSPECT, "Roof inspection"), catalogRow(REPAIR, "Shingle repair", "per_measure", { sort_order: 2 })],
      setup_intakes: [
        {
          id: "intake-1",
          organization_id: ORG,
          company_id: COMPANY,
          token: "t".repeat(32),
          status: "submitted",
          answers: answers(),
          enrichment: {},
          enrich_attempts: 0,
          submitted_at: "2026-10-08T12:00:00.000Z",
          updated_at: "2026-10-08T12:00:00.000Z",
          ...intake,
        },
      ],
    },
    {},
  );
  admin = db.client;
  deps = {
    getPlaceDetails: vi.fn(async () => PLACE),
    crawlWebsite: vi.fn(async () => CRAWL),
    draftCatalog: vi.fn(async () => ({ drafts: DRAFTS, usage: null })),
    now: () => Date.parse("2026-10-08T12:05:00.000Z"),
  };
}

beforeEach(() => seed());

const NOW = Date.parse("2026-10-08T12:05:00.000Z");
const intake = () => db.tables.setup_intakes[0];
const company = () => db.tables.companies[0];
const items = () => db.tables.service_catalog_items;

describe("site prices + descriptions are checked against the crawled text", () => {
  it("a price counts only when the amount is written next to the service name", () => {
    const text = "Our services. Roof inspection $150. Shingle repair from $9/sq ft. Skylight install $1,200. Snow plowing 85$ per visit.";
    expect(priceStatedNearService(text, "Roof Inspections", 15000)).toBe(true);
    expect(priceStatedNearService(text, "Skylight installation", 120000)).toBe(true);
    expect(priceStatedNearService(text, "Snow plowing", 8500)).toBe(true);
    expect(priceStatedNearService(text, "Gutter cleaning", 20000)).toBe(false); // amount not on the page
    expect(priceStatedNearService(text, "Gutter cleaning", 15000)).toBe(false); // amount is there, but not by this service
    expect(priceStatedNearService(text, "Roof inspection", 1500)).toBe(false); // $15 ≠ $150
    expect(priceStatedNearService("Roof inspection $150.50", "Roof inspection", 15000)).toBe(false);
    expect(priceStatedNearService("Roof inspection: $150.00", "Roof inspection", 15000)).toBe(true);
  });

  it("descriptions survive only verbatim; dropped prices are recorded", () => {
    const text = "Skylight install $1,200 — supply and install, all in.";
    const { drafts, droppedPrices } = verifyDraftsAgainstPages(
      [
        { name: "Skylight installation", description: "Supply and install, all in.", pricingType: "flat", baseCents: 120000 },
        { name: "Roof inspection", description: "Fully insured, 20 years experience.", pricingType: "flat", baseCents: 15000 },
      ],
      text,
    );
    expect(drafts[0]).toMatchObject({ baseCents: 120000, description: "Supply and install, all in." });
    expect(drafts[1]).toMatchObject({ baseCents: null, description: null });
    expect(droppedPrices).toEqual([{ label: "Roof inspection", cents: 15000, pricingType: "flat", reason: "price not written next to this service on the site" }]);
    expect(descriptionOnPage(text, "short")).toBe(false);
  });
});

describe("re-submit: only owner prices that changed since the last submit are applied", () => {
  it("an unchanged answer leaves the app's current price alone; a changed one is written", () => {
    const catalog = [catalogRow(REPAIR, "Shingle repair", "flat", { rate_cents: 1300, active: true }), catalogRow(INSPECT, "Roof inspection")];
    const owner = answers({ prices: { skipped: false, items: [{ id: REPAIR, label: "Shingle repair", priceCents: 1100 }, { id: INSPECT, label: "Roof inspection", priceCents: 17500 }] } });
    // Last submit: repair 1100 (since edited to 1300 in the app), inspection 15000.
    const plan = planServicePrices(catalog as never, owner, [], { [REPAIR]: 1100, [INSPECT]: 15000 });
    expect(plan.ops).toEqual([{ kind: "price", id: INSPECT, label: "Roof inspection", cents: 17500, source: "owner" }]);
    expect(ownerPriceMap(owner)).toEqual({ [REPAIR]: 1100, [INSPECT]: 17500 });
    // First submit (no record): everything applies.
    expect(planServicePrices(catalog as never, owner, []).ops).toHaveLength(2);
  });
});

describe("the picked Google listing must match the business", () => {
  it("matches by phone (business line / owner) or by name (word overlap)", () => {
    const company = { name: "Jane's Roofing Ltd.", phones: ["+17055550199", null] };
    expect(listingMatchesCompany({ name: "Totally Different", phoneNational: "(705) 555-0199" }, company)).toMatchObject({ matched: true, by: "phone" });
    expect(listingMatchesCompany({ name: "Jane's Roofing & Repairs", phoneNational: "(416) 555-0000" }, company)).toMatchObject({ matched: true, by: "name" });
    expect(listingMatchesCompany({ name: "Roofing Inc", phoneNational: null }, { name: "Northshore Snow and Lawn", phones: [] }).matched).toBe(false);
    const miss = listingMatchesCompany({ name: "Bob's Bakery", phoneNational: "(416) 555-0000" }, company);
    expect(miss.matched).toBe(false);
    expect(miss.reason).toContain("Bob's Bakery");
  });

  it("a listing that doesn't match is not used at all and is flagged for the operator", async () => {
    deps.getPlaceDetails = vi.fn(async () => ({ ...PLACE, name: "Bob's Bakery", phoneNational: "(416) 555-0000", website: "https://bobsbakery.ca/" }));
    await enrichCompany(admin, COMPANY, deps);
    expect(company()).toMatchObject({ brand_review_url: null, service_area: null, hours: null, website: null });
    expect("google_rating" in company()).toBe(false);
    expect(company().google_place_id ?? null).toBeNull();
    expect(deps.crawlWebsite).not.toHaveBeenCalled(); // never crawls the stranger's website
    const summary = intake().enrichment as Row;
    expect(summary.listingCheck).toMatchObject({ needed: true, placeId: PLACE_ID });
    expect(String((summary.listingCheck as Row).reason)).toContain("Bob's Bakery");
    expect(summary.facts).toMatchObject({ place: { name: "Bob's Bakery" } });
    // The owner's own answers still apply.
    expect(items().find((i) => i.id === REPAIR)?.rate_cents).toBe(1100);
  });
});

describe("enrichCompany + processPendingEnrichments", () => {
  it("retry-exhausted rows never starve new answers (filtered in SQL, oldest first)", async () => {
    for (let i = 0; i < 60; i++) {
      db.tables.setup_intakes.push({
        id: `old-${i}`,
        organization_id: ORG,
        company_id: `c-${i}`,
        token: `${i}`.padEnd(32, "x"),
        status: "failed",
        answers: answers(),
        enrichment: {},
        enrich_attempts: 3,
        submitted_at: "2026-09-01T12:00:00.000Z",
        updated_at: "2026-09-01T12:00:00.000Z",
      });
    }
    const result = await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(result).toMatchObject({ claimed: 1, enriched: 1 });
    expect(intake().status).toBe("enriched");
    const retryQuery = db.queries.find((q) => q.table === "setup_intakes" && q.op === "select" && q.filters.some((f) => f.column === "enrich_attempts"));
    expect(retryQuery?.filters).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "lt", column: "enrich_attempts", value: 3 })]));
  });

  it("submitted → enriched: company facts, owner + site prices (active), new priced services, structured summary", async () => {
    const result = await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(result).toEqual({ claimed: 1, enriched: 1, failed: 0 });
    expect(intake()).toMatchObject({ status: "enriched", enrich_attempts: 1, last_error: null });
    expect(intake().enriched_at).toBeTruthy();
    expect(deps.getPlaceDetails).toHaveBeenCalledWith(PLACE_ID);
    expect(deps.crawlWebsite).toHaveBeenCalledWith("https://janesroofing.ca/", "Jane's Roofing");

    expect(company()).toMatchObject({
      website: "https://janesroofing.ca/",
      service_area: "Barrie and surrounding area",
      google_place_id: PLACE_ID,
      google_rating: 4.8,
      google_review_count: 38,
      brand_logo_url: "https://janesroofing.ca/logo.png",
      business_phone_carrier: "rogers",
    });
    expect(items().find((i) => i.id === REPAIR)).toMatchObject({ rate_cents: 1100, active: true });
    expect(items().find((i) => i.id === INSPECT)).toMatchObject({ rate_cents: 15000, active: true });
    expect(items().filter((i) => i.label === "Skylight installation")).toEqual([
      expect.objectContaining({ rate_cents: 120000, active: true, pricing_type: "flat", organization_id: ORG, company_id: COMPANY }),
    ]);
    expect(items().some((i) => i.label === "Chimney flashing")).toBe(false);

    const summary = intake().enrichment as Row;
    expect(summary).toMatchObject({
      version: 1,
      sources: { google: { placeId: PLACE_ID, used: true }, website: { url: "https://janesroofing.ca/" }, catalogParser: { used: true, services: 5 } },
      services: {
        priced: [
          { id: REPAIR, label: "Shingle repair", cents: 1100, source: "owner" },
          { id: INSPECT, label: "Roof inspection", cents: 15000, source: "website" },
        ],
        // "Gutter cleaning $200" came from the parser but isn't written on the page → dropped.
        unpricedOnSite: ["Chimney flashing", "Gutter cleaning"],
        notApplied: expect.arrayContaining([expect.objectContaining({ label: "Gutter cleaning", cents: 20000, reason: "price not written next to this service on the site" })]),
        skippedByOwner: false,
      },
      facts: { place: { name: "Jane's Roofing", phone: "(705) 555-0101" } },
    });
    expect(JSON.stringify(summary)).not.toMatch(/review text|photos/i);

    // Every company/catalog write is scoped to the intake's org + company.
    const writes = db.queries.filter((q) => (q.table === "companies" || q.table === "service_catalog_items") && q.op === "update");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.filters).toEqual(expect.arrayContaining([expect.objectContaining({ column: "organization_id", value: ORG })]));
    }
  });

  it("re-running is idempotent: same facts, no duplicate services", async () => {
    await enrichCompany(admin, COMPANY, deps);
    const snapshot = JSON.stringify({ c: company(), i: items() });
    await enrichCompany(admin, COMPANY, deps);
    expect(items().filter((i) => i.label === "Skylight installation")).toHaveLength(1);
    expect(JSON.stringify({ c: company(), i: items() })).toBe(snapshot);
  });

  it("Places down / site unreachable / no AI → still enriched from what we have (recorded), never invented", async () => {
    deps.getPlaceDetails = vi.fn(async () => {
      throw new Error("Google Places 503");
    });
    deps.draftCatalog = null;
    await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(intake().status).toBe("enriched");
    const summary = intake().enrichment as { sources: Row };
    expect(summary.sources.google).toMatchObject({ used: false, error: "Google Places 503" });
    // No listing details → no website to read; the owner's own price still applies.
    expect(summary.sources.website).toBeNull();
    expect(items().find((i) => i.id === INSPECT)?.rate_cents).toBe(0);
    expect(items().find((i) => i.id === REPAIR)?.rate_cents).toBe(1100);

    // Website given but no AI: crawled facts used, site prices skipped (recorded).
    seed({ answers: answers({ listing: { kind: "website", url: "https://janesroofing.ca/" } }) });
    deps.draftCatalog = null;
    await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(intake().status).toBe("enriched");
    expect((intake().enrichment as { sources: Row }).sources.catalogParser).toMatchObject({ used: false, error: "AI not configured" });
    expect(company().brand_logo_url).toBe("https://janesroofing.ca/logo.png");
    expect(items().find((i) => i.id === INSPECT)?.rate_cents).toBe(0);

    // Site unreachable: recorded, still enriched.
    seed({ answers: answers({ listing: { kind: "website", url: "https://janesroofing.ca/" } }) });
    deps.crawlWebsite = vi.fn(async () => {
      throw new Error("The site took too long to respond.");
    });
    await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(intake().status).toBe("enriched");
    expect((intake().enrichment as { sources: Row }).sources.website).toMatchObject({ pages: [], error: "The site took too long to respond." });
  });

  it("a DB failure → failed with last_error, retried later (max a few times)", async () => {
    db.failNext("companies", "update", { message: "deadlock" });
    expect(await processPendingEnrichments(admin, { nowMs: NOW }, deps)).toMatchObject({ claimed: 1, failed: 1 });
    expect(intake()).toMatchObject({ status: "failed", enrich_attempts: 1 });
    expect(intake().last_error).toContain("deadlock");
    expect(isEnrichmentDue(intake() as never, Date.parse(intake().updated_at as string) + 60_000)).toBe(false);
    expect(isEnrichmentDue(intake() as never, Date.parse(intake().updated_at as string) + 11 * 60_000)).toBe(true);
    expect(isEnrichmentDue({ status: "failed", enrich_attempts: MAX_ENRICH_ATTEMPTS, updated_at: "2026-01-01T00:00:00Z" }, NOW)).toBe(false);
    expect(isEnrichmentDue({ status: "enriching", enrich_attempts: 1, updated_at: new Date(NOW - 20 * 60_000).toISOString() }, NOW)).toBe(true);
    expect(isEnrichmentDue({ status: "enriching", enrich_attempts: 1, updated_at: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(false);
  });

  it("claim race: a row another worker already claimed is skipped", async () => {
    // Worker B claims between worker A's read and A's claim.
    const originalFrom = (db.client as unknown as { from: (t: string) => unknown }).from;
    let raced = false;
    (db.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const builder = originalFrom(table) as Record<string, unknown>;
      if (table === "setup_intakes" && !raced) {
        const update = builder.update as (row: Row) => unknown;
        builder.update = (row: Row) => {
          if (row.status === "enriching" && !raced) {
            raced = true;
            Object.assign(db.tables.setup_intakes[0], { status: "enriching", enrich_attempts: 1 });
          }
          return update(row);
        };
      }
      return builder;
    };
    const result = await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(result).toMatchObject({ claimed: 0, enriched: 0 });
    expect(deps.crawlWebsite).not.toHaveBeenCalled();
  });

  it("one sweep at a time per process", async () => {
    let release!: () => void;
    deps.crawlWebsite = vi.fn(() => new Promise<CrawlResult>((resolve) => (release = () => resolve(CRAWL))));
    const first = processPendingEnrichments(admin, { nowMs: NOW }, deps);
    await vi.waitFor(() => expect(deps.crawlWebsite).toHaveBeenCalled());
    expect(await processPendingEnrichments(admin, { nowMs: NOW }, deps)).toMatchObject({ skipped: "in_flight" });
    release();
    expect((await first).enriched).toBe(1);
  });

  it("a re-submit during a run sends it round again (the finished run doesn't mark it enriched)", async () => {
    deps.crawlWebsite = vi.fn(async () => {
      // The buyer changes an answer while we crawl.
      Object.assign(intake(), { status: "submitted", enrich_attempts: 0 });
      return CRAWL;
    });
    await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(intake().status).toBe("submitted");
    expect(isEnrichmentDue(intake() as never, NOW)).toBe(true);
  });

  it("No website + no listing: only the owner's answers are used", async () => {
    seed({ answers: answers({ listing: { kind: "none" } }) });
    await processPendingEnrichments(admin, { nowMs: NOW }, deps);
    expect(deps.getPlaceDetails).not.toHaveBeenCalled();
    expect(deps.crawlWebsite).not.toHaveBeenCalled();
    expect(intake().status).toBe("enriched");
    expect(company()).toMatchObject({ website: null, business_phone_kind: "cell" });
  });
});
