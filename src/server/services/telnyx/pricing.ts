/**
 * Adapter from what a voice assistant can collect on a phone call to a price.
 * Pricing is NEVER computed here — this only maps inputs to a catalog line and
 * refuses to guess.
 *
 * Marina is per-brand: a call resolves to ONE company, and we price from THAT
 * company's service catalog (priceFromCatalog, integer CENTS). A service the
 * brand doesn't sell isn't in its catalog, so it comes back `unsupported` — the
 * assistant offers a callback rather than quoting a neighbouring brand's price.
 */
import { priceFromCatalog, type CatalogLineInput, type ServiceCatalog } from "@/server/services/quotes/catalog";

export type EngineType = "outboard" | "sterndrive" | "inboard";

export interface TelnyxQuoteInput {
  boatLengthFt: number | null;
  boatType: string | null;
  engineCount: number | null;
  engineType: EngineType | null;
  serviceType: string | null;
  /** Marine-care detailing tier: refresh | standard | deep | restoration. */
  tier: string | null;
}

export interface QuoteLineItemCents {
  amountCents: number;
  label: string;
}

export type QuoteOutcome =
  | {
      currency: "CAD";
      depositCents: number;
      lineItems: QuoteLineItemCents[];
      quoteTotalCents: number;
      spokenSummary: string;
      status: "quoted";
    }
  | { missing: string[]; status: "missing_info" }
  | { reason: string; status: "unsupported" };

const DETAILING_TIERS = ["refresh", "standard", "deep", "restoration"] as const;

/**
 * BUSINESS RULE, NOT CATALOG OUTPUT: the booking deposit. The catalog has no
 * deposit concept, so this is configurable rather than invented per-call.
 * Flat cents (default $100) unless TELNYX_DEPOSIT_PERCENT is set.
 */
function depositCentsFor(totalCents: number): number {
  const percent = Number.parseFloat(process.env.TELNYX_DEPOSIT_PERCENT ?? "");
  if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
    return Math.round((totalCents * percent) / 100);
  }
  const flat = Number.parseInt(process.env.TELNYX_DEPOSIT_CENTS ?? "", 10);
  const flatCents = Number.isFinite(flat) && flat >= 0 ? flat : 10_000;
  // Never quote a deposit larger than the job itself.
  return Math.min(flatCents, totalCents);
}

/** Speech-friendly money: "$432", "$432.50" — never "$432.00". */
export function spokenAmount(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}

export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

function normalizeServiceType(raw: string | null): string | null {
  if (!raw) return null;
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function describeBoat(input: TelnyxQuoteInput): string {
  const length = input.boatLengthFt ? `${input.boatLengthFt}-foot ` : "";
  const type = input.boatType?.trim() ? input.boatType.trim().toLowerCase() : "boat";
  return `${length}${type}`;
}

function buildSpokenSummary(
  serviceLabel: string,
  input: TelnyxQuoteInput,
  totalCents: number,
  depositCents: number,
): string {
  return (
    `${serviceLabel} for a ${describeBoat(input)} comes to ${spokenAmount(totalCents)}, ` +
    `with a ${spokenAmount(depositCents)} deposit to book.`
  );
}

/** Price one catalog line for the caller's brand, or hand off if the brand doesn't sell it. */
function quotedFromCatalog(
  serviceLabel: string,
  input: TelnyxQuoteInput,
  catalog: ServiceCatalog | null,
  line: CatalogLineInput,
): QuoteOutcome {
  if (!catalog) {
    return { reason: "Pricing isn't set up for this location yet.", status: "unsupported" };
  }

  let priced;
  try {
    priced = priceFromCatalog({ catalog, lines: [line] });
  } catch {
    // Unknown service for this brand, or an input the catalog rejects (a required
    // modifier, a length past a cap, a manual-review combination) — hand off
    // rather than quote a neighbouring brand's price or guess.
    return { reason: `This location doesn't quote "${line.serviceKey}" by phone.`, status: "unsupported" };
  }

  const totalCents = priced.subtotalCents;
  const deposit = depositCentsFor(totalCents);

  return {
    currency: "CAD",
    depositCents: deposit,
    lineItems: priced.lines.map((l) => ({ amountCents: l.amountCents, label: l.label })),
    quoteTotalCents: totalCents,
    spokenSummary: buildSpokenSummary(serviceLabel, input, totalCents, deposit),
    status: "quoted",
  };
}

/**
 * Map a collected service to a price against the caller's brand catalog. Returns
 * `missing_info` (never a guess) when an input the caller hasn't given is needed,
 * and `unsupported` when the brand doesn't sell it.
 */
export function priceTelnyxQuote(input: TelnyxQuoteInput, catalog: ServiceCatalog | null): QuoteOutcome {
  const serviceType = normalizeServiceType(input.serviceType);
  if (!serviceType) {
    return { missing: ["service_type"], status: "missing_info" };
  }

  switch (serviceType) {
    case "shrink_wrap":
    case "shrinkwrap": {
      if (input.boatLengthFt == null) {
        return { missing: ["boat_length_ft"], status: "missing_info" };
      }
      return quotedFromCatalog("Shrink wrap", input, catalog, {
        serviceKey: "shrink_wrap",
        measure: input.boatLengthFt,
      });
    }

    case "outdoor_storage":
    case "storage": {
      if (input.boatLengthFt == null) {
        return { missing: ["boat_length_ft"], status: "missing_info" };
      }
      return quotedFromCatalog("Outdoor winter storage", input, catalog, {
        serviceKey: "outdoor_storage",
        measure: input.boatLengthFt,
      });
    }

    case "winterization": {
      // Per engine — the engine type picks the catalog service, so it's required.
      if (!input.engineType) {
        return { missing: ["engine_type"], status: "missing_info" };
      }
      return quotedFromCatalog(`Winterization (${input.engineType})`, input, catalog, {
        serviceKey: `winterization_${input.engineType}`,
        quantity: input.engineCount ?? 1,
      });
    }

    case "ceramic":
    case "ceramic_coating": {
      if (input.boatLengthFt == null) {
        return { missing: ["boat_length_ft"], status: "missing_info" };
      }
      return quotedFromCatalog("Ceramic coating", input, catalog, {
        serviceKey: "ceramic",
        measure: input.boatLengthFt,
      });
    }

    case "detailing":
    case "boat_detailing":
    case "exterior_detailing": {
      if (input.boatLengthFt == null) {
        return { missing: ["boat_length_ft"], status: "missing_info" };
      }
      // Detailing is tiered and the tiers price very differently, so we ask
      // rather than defaulting one in.
      const tier = input.tier?.trim().toLowerCase();
      if (!tier || !DETAILING_TIERS.includes(tier as (typeof DETAILING_TIERS)[number])) {
        return { missing: ["tier"], status: "missing_info" };
      }
      return quotedFromCatalog(
        `${tier.charAt(0).toUpperCase()}${tier.slice(1)} exterior detailing`,
        input,
        catalog,
        { serviceKey: "exterior_detailing", measure: input.boatLengthFt, modifiers: { tier } },
      );
    }

    default:
      return {
        reason: `No pricing mapping for service type "${serviceType}".`,
        status: "unsupported",
      };
  }
}
