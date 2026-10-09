/**
 * Quick-setup intake (/setup/:token) — shared, browser-safe vocabulary for the page and the
 * server (docs/done-for-you.md, "Intake & enrichment"). Keys are what we store
 * (companies.business_phone_kind / business_phone_carrier, setup_intakes.answers); labels are
 * what the buyer sees.
 */

export const BUSINESS_PHONE_KINDS = ["cell", "landline", "voip"] as const;
export type BusinessPhoneKind = (typeof BUSINESS_PHONE_KINDS)[number];

export const BUSINESS_PHONE_KIND_LABELS: Record<BusinessPhoneKind, string> = {
  cell: "Cell",
  landline: "Landline",
  voip: "VoIP",
};

export const PHONE_CARRIERS = [
  { key: "bell", label: "Bell" },
  { key: "rogers", label: "Rogers" },
  { key: "telus", label: "Telus" },
  { key: "fido", label: "Fido" },
  { key: "koodo", label: "Koodo" },
  { key: "virgin", label: "Virgin Plus" },
  { key: "freedom", label: "Freedom" },
  { key: "videotron", label: "Videotron" },
  { key: "eastlink", label: "Eastlink" },
  { key: "cogeco", label: "Cogeco" },
  { key: "shaw", label: "Shaw" },
  { key: "other", label: "Other / not sure" },
] as const;
export type PhoneCarrierKey = (typeof PHONE_CARRIERS)[number]["key"];
export const PHONE_CARRIER_KEYS = PHONE_CARRIERS.map((c) => c.key) as [PhoneCarrierKey, ...PhoneCarrierKey[]];

/** Price units the buyer can pick for a service they add themselves. */
export const NEW_SERVICE_UNITS = [
  { key: "flat", label: "Flat price", pricingType: "flat", unit: null },
  { key: "visit", label: "Per visit", pricingType: "flat", unit: "visit" },
  { key: "hour", label: "Per hour", pricingType: "per_unit", unit: "hour" },
  { key: "ft", label: "Per ft", pricingType: "per_measure", unit: "ft" },
  { key: "sqft", label: "Per sq ft", pricingType: "per_measure", unit: "sq ft" },
] as const;
export type NewServiceUnitKey = (typeof NEW_SERVICE_UNITS)[number]["key"];
export const NEW_SERVICE_UNIT_KEYS = NEW_SERVICE_UNITS.map((u) => u.key) as [NewServiceUnitKey, ...NewServiceUnitKey[]];

/** "per visit" / "per hour" / "flat price" — how a catalog item's price reads next to the box. */
export function priceUnitLabel(pricingType: string, unit: string | null | undefined): string {
  const u = unit?.trim();
  if (u) return `per ${u}`;
  return pricingType === "flat" ? "flat price" : "each";
}

/** "$1,250" / "$85.50" → cents; "" → null; anything unreadable → NaN. */
export function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null || cents <= 0) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** The answers the page posts (validated again server-side). */
export type IntakeListingAnswer =
  | { kind: "google"; placeId: string; name: string; address: string | null }
  | { kind: "website"; url: string }
  | { kind: "none" };

export interface IntakePriceAnswer {
  /** Existing catalog item, or absent for one the buyer added. */
  id?: string;
  label: string;
  priceCents: number;
  /** Only for added services. */
  unit?: NewServiceUnitKey;
}

export interface IntakeAnswers {
  listing: IntakeListingAnswer;
  phone: { number: string; kind: BusinessPhoneKind; carrier: PhoneCarrierKey };
  prices: { skipped: boolean; items: IntakePriceAnswer[] };
}
