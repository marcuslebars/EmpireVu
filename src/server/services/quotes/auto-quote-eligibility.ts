/**
 * Should this lead get an instant, self-serve quote?
 *
 * A PURE decision function. Auto-quoting means a customer can approve and pay a
 * deposit without anyone looking at the job first, so the bar is deliberately
 * high: everything the lead asked for must be priceable from the tenant's
 * catalog with no judgement, and anything that smells like a site visit, an
 * unusual vessel, or a hand-quoted service disqualifies it.
 *
 * DECLINING IS THE SAFE ANSWER. A lead that falls through here is handled the
 * way every lead is handled today — it reaches a human, who quotes it. The only
 * cost is a slower reply. Auto-quoting something that needed eyes on it means
 * taking a deposit for work at a price nobody stands behind, and then having to
 * go back to the customer to raise it.
 *
 * Every rejection carries a reason, recorded on the lead, so "why didn't this
 * one auto-quote?" is answerable without re-running the logic in your head.
 */
import type { ServiceCatalog } from "./catalog";

export type AutoQuoteRejection =
  | "feature_disabled"
  | "wrong_form_type"
  | "no_company"
  | "no_catalog"
  | "no_boat_length"
  | "implausible_boat_length"
  | "unknown_engine_type"
  | "no_services_requested"
  | "unpriceable_service"
  | "care_service_interest"
  | "in_water_complication"
  | "transport_beyond_band"
  | "already_quoted";

export interface AutoQuoteDecision {
  eligible: boolean;
  reason?: AutoQuoteRejection;
  /** Human-readable, recorded on the lead for the review list. */
  detail?: string;
}

const ELIGIBLE = { eligible: true } as const;

const decline = (reason: AutoQuoteRejection, detail: string): AutoQuoteDecision => ({
  eligible: false,
  reason,
  detail,
});

/**
 * Engine types the catalog can winterize. "Not sure" is the important one: a
 * customer who does not know their engine type cannot be quoted for
 * winterization, and guessing the cheapest is how you end up eating the
 * difference.
 */
const KNOWN_ENGINE_TYPES = new Set(["outboard", "sterndrive", "inboard"]);

/**
 * Free-text that means a human should look. Care work (detailing, restoration,
 * coatings) is hand-quoted, and in-water or lift storage needs a haul-out plan
 * that has no price attached.
 */
const CARE_MARKERS = [
  "detail",
  "restoration",
  "gelcoat",
  "ceramic",
  "coating",
  "polish",
  "wax",
  "buff",
  "wet sand",
  "bottom paint",
  "vinyl",
];

/**
 * Note "in the water" as well as "in water" — the natural phrasing is the one
 * people actually type, and missing it would have let exactly the leads this
 * guard exists for slip through and be auto-quoted without a haul-out plan.
 *
 * "on the water" is deliberately ABSENT: it shows up in perfectly ordinary
 * sentences ("looking forward to being back on the water in spring") and would
 * decline good leads. Declining is safe but not free — over-declining quietly
 * turns the feature off.
 */
const IN_WATER_MARKERS = [
  "in the water",
  "in water",
  "in-water",
  "on a lift",
  "on the lift",
  "lift",
  "haul out",
  "haul-out",
  "haulout",
  "slip",
  "moored",
  "docked",
  "at the dock",
];

function mentions(haystack: string, needles: string[]): string | null {
  const text = haystack.toLowerCase();
  return needles.find((n) => text.includes(n)) ?? null;
}

export interface AutoQuoteCandidate {
  enabled: boolean;
  formType: string | null;
  companyId: string | null;
  catalog: ServiceCatalog | null;
  boatLengthFt: number | null;
  engineType: string | null;
  /** Catalog service keys the lead is asking for. */
  requestedServiceKeys: string[];
  /** Anything the customer typed: message, service-interest field, notes. */
  freeText: string;
  /** Resolved transport band, if the lead carried one. */
  transportBand: string | null;
  /** True when a quote already exists for this lead. */
  alreadyQuoted: boolean;
}

export function decideAutoQuote(c: AutoQuoteCandidate): AutoQuoteDecision {
  if (!c.enabled) return decline("feature_disabled", "SELF_SERVE_QUOTES_ENABLED is not set");

  // Only the storage quote form. A contact or booking form has not told us
  // enough to price anything.
  if (c.formType !== "winter-storage-quote" && c.formType !== "quote") {
    return decline("wrong_form_type", `formType "${c.formType}" is not a quote request`);
  }

  if (!c.companyId) return decline("no_company", "lead did not route to a company");
  if (!c.catalog) return decline("no_catalog", "company has no service catalog");

  // Idempotency. The partial unique index on (organization_id, source_lead_id)
  // is the real guard; this keeps us from doing the work to hit it.
  if (c.alreadyQuoted) return decline("already_quoted", "an auto-quote already exists for this lead");

  if (c.boatLengthFt == null) return decline("no_boat_length", "no boat length given");
  if (!(c.boatLengthFt > 0) || c.boatLengthFt > 80) {
    return decline("implausible_boat_length", `boat length ${c.boatLengthFt}ft is outside the auto-quote range`);
  }

  if (c.requestedServiceKeys.length === 0) {
    return decline("no_services_requested", "no services identified in the lead");
  }

  // Care work is hand-quoted; a detailing job's price depends on what the boat
  // actually looks like.
  const careHit = mentions(c.freeText, CARE_MARKERS);
  if (careHit) {
    return decline("care_service_interest", `mentions "${careHit}" — Care work is quoted by hand`);
  }

  // In-water or lift storage needs a haul-out plan, which has no priced line.
  const waterHit = mentions(c.freeText, IN_WATER_MARKERS);
  if (waterHit) {
    return decline("in_water_complication", `mentions "${waterHit}" — needs a haul-out plan`);
  }

  // Beyond the furthest band transport is quoted by hand, so the total would be
  // incomplete — and a customer must never pay a deposit against a partial price.
  if (c.transportBand === "beyond") {
    return decline("transport_beyond_band", "transport is beyond the furthest band and is quoted by hand");
  }

  // Winterization needs a known engine type. "Not sure" is a real answer on the
  // form and must not be guessed.
  const needsEngine = c.requestedServiceKeys.some((k) => k.startsWith("winterization"));
  if (needsEngine && !KNOWN_ENGINE_TYPES.has(String(c.engineType ?? "").toLowerCase())) {
    return decline("unknown_engine_type", `engine type "${c.engineType ?? "none"}" cannot be priced`);
  }

  // Every requested service must exist in THIS company's catalog. A service the
  // brand does not sell is a conversation, not a line item.
  const missing = c.requestedServiceKeys.filter((k) => !c.catalog!.items[k]);
  if (missing.length > 0) {
    return decline("unpriceable_service", `not in this company's catalog: ${missing.join(", ")}`);
  }

  return ELIGIBLE;
}

/** Copy for the confirmation email, so the two paths read differently on purpose. */
export function confirmationVariant(decision: AutoQuoteDecision): "instant_quote" | "quote_coming" {
  return decision.eligible ? "instant_quote" : "quote_coming";
}
