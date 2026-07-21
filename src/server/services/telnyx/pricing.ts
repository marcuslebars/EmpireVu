/**
 * Adapter from what a voice assistant can collect on a phone call to the
 * @a1/pricing-engine API. Pricing is NEVER computed here — this only maps
 * inputs, and refuses to guess.
 *
 * Two engine surfaces with different shapes and DIFFERENT UNITS:
 *   • storage  → calculateQuote()  → QuoteResult, amounts in CENTS
 *   • marine care → calculateCeramic()/calculateExterior() → PricingResult,
 *     `subtotal` in DOLLARS, and only human-readable `breakdown` strings
 * Everything below is normalized to CENTS so a 100× error can't slip through.
 */
import {
  calculateCeramic,
  calculateExterior,
  calculateQuote,
} from "@a1/pricing-engine";

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
 * BUSINESS RULE, NOT PRICING-ENGINE OUTPUT: the booking deposit. The engine has
 * no deposit concept, so this is configurable rather than invented per-call.
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

function quotedFromStorage(
  serviceId: string,
  serviceLabel: string,
  input: TelnyxQuoteInput,
): QuoteOutcome {
  // NOTE: hullType is deliberately not passed. Hull surcharges would change the
  // price and a caller's free-text boat type isn't a reliable hull classifier.
  const result = calculateQuote({
    items: [
      {
        engineCount: input.engineCount ?? 1,
        engineType: input.engineType ?? undefined,
        lengthFt: input.boatLengthFt ?? undefined,
        serviceId,
      },
    ],
    serviceLine: "storage",
  });

  const totalCents = result.totalCents;
  const deposit = depositCentsFor(totalCents);

  return {
    currency: "CAD",
    depositCents: deposit,
    lineItems: result.lineItems.map((line) => ({
      amountCents: line.amountCents,
      label: line.label,
    })),
    quoteTotalCents: totalCents,
    spokenSummary: buildSpokenSummary(serviceLabel, input, totalCents, deposit),
    status: "quoted",
  };
}

/** Marine-care results are in DOLLARS and carry no structured line items. */
function quotedFromCare(
  serviceLabel: string,
  input: TelnyxQuoteInput,
  subtotalDollars: number,
  breakdown: string[],
): QuoteOutcome {
  const totalCents = Math.round(subtotalDollars * 100);
  const deposit = depositCentsFor(totalCents);

  return {
    currency: "CAD",
    depositCents: deposit,
    lineItems:
      breakdown.length > 0
        ? breakdown.map((label) => ({ amountCents: totalCents, label }))
        : [{ amountCents: totalCents, label: serviceLabel }],
    quoteTotalCents: totalCents,
    spokenSummary: buildSpokenSummary(serviceLabel, input, totalCents, deposit),
    status: "quoted",
  };
}

/**
 * Map a collected service to a price. Returns `missing_info` (never a guess)
 * when the engine needs an input the caller hasn't given yet — the assistant
 * asks for it and retries.
 */
export function priceTelnyxQuote(input: TelnyxQuoteInput): QuoteOutcome {
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
      return quotedFromStorage("shrink_wrap", "Shrink wrap", input);
    }

    case "outdoor_storage":
    case "storage": {
      if (input.boatLengthFt == null) {
        return { missing: ["boat_length_ft"], status: "missing_info" };
      }
      return quotedFromStorage("outdoor_storage", "Outdoor winter storage", input);
    }

    case "winterization": {
      // Flat per engine — the engine type picks the service, so it's required.
      if (!input.engineType) {
        return { missing: ["engine_type"], status: "missing_info" };
      }
      return quotedFromStorage(
        `winterization_${input.engineType}`,
        `Winterization (${input.engineType})`,
        input,
      );
    }

    case "ceramic":
    case "ceramic_coating": {
      if (input.boatLengthFt == null) {
        return { missing: ["boat_length_ft"], status: "missing_info" };
      }
      // Base coating only. Add-ons (second layer, teak, interior) aren't things
      // a caller volunteers, and each changes the price — so they stay off.
      const result = calculateCeramic(input.boatLengthFt, {
        interiorCeramic: false,
        secondLayer: false,
        teakCeramic: false,
      });
      return quotedFromCare("Ceramic coating", input, result.subtotal, result.breakdown);
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
      const result = calculateExterior(input.boatLengthFt, {
        canvasCleaning: false,
        exteriorOzone: false,
        fenderCleaning: false,
        teakCleaning: false,
        tier: tier as (typeof DETAILING_TIERS)[number],
      });
      return quotedFromCare(
        `${tier.charAt(0).toUpperCase()}${tier.slice(1)} exterior detailing`,
        input,
        result.subtotal,
        result.breakdown,
      );
    }

    default:
      return {
        reason: `No pricing mapping for service type "${serviceType}".`,
        status: "unsupported",
      };
  }
}
