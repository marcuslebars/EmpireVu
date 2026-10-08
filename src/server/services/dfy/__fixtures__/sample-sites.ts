import type { CatalogItemFacts, SiteFactsInput } from "../site-content";

/**
 * Three sample companies for the generated-site renderer (tests + the screenshots in
 * docs/done-for-you.md): a snow removal company with no website and full data ("full"), a
 * roofer with a website and no prices ("price_page"), and a sparse company with almost nothing.
 */

function item(key: string, label: string, pricing_type: string, rate_cents: number, extra: Partial<CatalogItemFacts> = {}): CatalogItemFacts {
  return { service_key: key, label, description: null, pricing_type, rate_cents, minimum_cents: 0, unit_label: null, ...extra };
}

export const snowCompany: SiteFactsInput = {
  company: {
    name: "Northshore Snow & Property",
    owner_phone_e164: "+17055550142",
    service_area: "Barrie, Innisfil and Oro-Medonte",
    hours: { mon: { open: "07:00", close: "18:00" }, tue: { open: "07:00", close: "18:00" }, wed: { open: "07:00", close: "18:00" }, thu: { open: "07:00", close: "18:00" }, fri: { open: "07:00", close: "18:00" }, sat: { open: "08:00", close: "14:00" }, sun: "closed" },
    google_rating: 4.8,
    google_review_count: 63,
    google_place_id: "ChIJ-sample-northshore",
    brand_review_url: "https://g.page/r/northshore-sample/review",
    website: null,
    brand_logo_url: null,
    brand_primary_color: null,
    brand_accent_color: null,
    business_address: null,
    profile: {
      tagline: null,
      about: "We plow, salt and shovel driveways and small commercial lots across south Barrie. In spring and fall we do yard cleanups for the same customers.",
      highlights: ["Seasonal contracts or pay per visit", "Salt and sand for walkways and lots"],
    },
  },
  catalog: [
    item("seasonal_residential", "Seasonal contract — residential driveway", "flat", 54900, { description: "Unlimited plows for a standard double driveway, November to April.", sort_order: 1 }),
    item("per_push_residential", "Per-visit plowing — residential", "per_unit", 6500, { unit_label: "visit", sort_order: 2 }),
    item("salting_driveway", "Salting — driveway and walkway", "per_unit", 3500, { unit_label: "application", sort_order: 3 }),
    item("walkway_shovelling", "Walkway and step shovelling", "per_unit", 2500, { unit_label: "visit", sort_order: 4 }),
    item("commercial_lot", "Commercial lot plowing", "per_measure", 0, { unit_label: "sq ft", sort_order: 5, description: "Small plazas and church lots, priced by size." }),
    item("roof_snow", "Roof snow removal", "flat", 0, { sort_order: 6 }),
    item("spring_cleanup", "Spring cleanup", "flat", 22500, { minimum_cents: 0, sort_order: 7, description: "Leaves, branches and winter debris raked and hauled away." }),
  ],
  trade: { id: "property-maintenance-snow", name: "Property maintenance & snow" },
  bookingEnabled: true,
  brand: "crankleads",
};

export const roofingCompany: SiteFactsInput = {
  company: {
    name: "Kawartha Ridge Roofing",
    owner_phone_e164: "+17055550187",
    service_area: "Peterborough and the Kawarthas",
    hours: { summary: "Mon–Fri 7am–5pm" },
    google_rating: null,
    google_review_count: null,
    google_place_id: null,
    brand_review_url: null,
    website: "https://kawartharidgeroofing.ca",
    brand_logo_url: null,
    brand_primary_color: null,
    brand_accent_color: null,
    business_address: null,
    profile: {},
  },
  catalog: [
    item("reroof", "Asphalt shingle re-roof", "per_measure", 0, { unit_label: "square", description: "Tear-off and new shingles for houses and cottages." }),
    item("repair", "Roof leak repair", "flat", 0, { description: "Find the leak, fix the flashing or shingles, and check the decking." }),
    item("metal", "Metal roofing", "per_measure", 0, { unit_label: "square" }),
    item("eaves", "Eavestrough install and repair", "per_measure", 0, { unit_label: "ft" }),
    item("inspection", "Roof inspection", "flat", 0),
  ],
  trade: { id: "roofing", name: "Roofing" },
  bookingEnabled: false,
  brand: "crankleads",
};

export const sparseCompany: SiteFactsInput = {
  company: {
    name: "J. Tremblay Contracting",
    owner_phone_e164: null,
    service_area: null,
    hours: null,
    google_rating: null,
    google_review_count: null,
    google_place_id: null,
    brand_review_url: null,
    website: null,
    brand_logo_url: null,
    brand_primary_color: null,
    brand_accent_color: null,
    business_address: null,
    profile: {},
  },
  catalog: [],
  trade: null,
  bookingEnabled: false,
  brand: "crankleads",
};
