import { describe, expect, it } from "vitest";

import a1Catalog from "@/server/services/quotes/__fixtures__/a1-catalog.json";
import {
  confirmationVariant,
  decideAutoQuote,
  type AutoQuoteCandidate,
} from "@/server/services/quotes/auto-quote-eligibility";
import type { ServiceCatalog } from "@/server/services/quotes/catalog";

const CATALOG = a1Catalog as unknown as ServiceCatalog;

/** A lead that SHOULD auto-quote. Each test spoils exactly one thing. */
const OK: AutoQuoteCandidate = {
  enabled: true,
  formType: "winter-storage-quote",
  companyId: "c1",
  catalog: CATALOG,
  boatLengthFt: 24,
  engineType: "outboard",
  requestedServiceKeys: ["outdoor_storage", "shrink_wrap", "winterization_outboard"],
  freeText: "Looking to store my bowrider for the winter.",
  transportBand: "local",
  alreadyQuoted: false,
};

const spoil = (over: Partial<AutoQuoteCandidate>) => decideAutoQuote({ ...OK, ...over });

describe("the happy path", () => {
  it("auto-quotes a clean storage lead", () => {
    expect(decideAutoQuote(OK)).toEqual({ eligible: true });
  });

  it("auto-quotes with no transport at all", () => {
    expect(spoil({ transportBand: null }).eligible).toBe(true);
  });

  it("auto-quotes storage-only, with no winterization and so no engine type", () => {
    expect(spoil({ requestedServiceKeys: ["outdoor_storage"], engineType: null }).eligible).toBe(true);
  });
});

/**
 * Declining is the SAFE answer: the lead reaches a human, who quotes it. The
 * only cost is a slower reply. Auto-quoting something that needed eyes on it
 * means taking a deposit at a price nobody stands behind.
 */
describe("guardrails — each one declines", () => {
  it("is off unless the flag is set", () => {
    expect(spoil({ enabled: false })).toMatchObject({ eligible: false, reason: "feature_disabled" });
  });

  it("declines a contact or booking form", () => {
    for (const formType of ["contact", "booking", null]) {
      expect(spoil({ formType }), String(formType)).toMatchObject({ reason: "wrong_form_type" });
    }
  });

  it("declines when the lead did not route to a company", () => {
    expect(spoil({ companyId: null })).toMatchObject({ reason: "no_company" });
  });

  it("declines when the company has no catalog", () => {
    // Without a price list there is nothing to quote from, and falling back to
    // another company's would quote a customer at prices their supplier never set.
    expect(spoil({ catalog: null })).toMatchObject({ reason: "no_catalog" });
  });

  it("declines without a boat length", () => {
    expect(spoil({ boatLengthFt: null })).toMatchObject({ reason: "no_boat_length" });
  });

  it("declines an implausible boat length", () => {
    for (const ft of [0, -5, 200]) {
      expect(spoil({ boatLengthFt: ft }), String(ft)).toMatchObject({
        reason: "implausible_boat_length",
      });
    }
  });

  it("declines when winterization is wanted but the engine type is unknown", () => {
    // "Not sure" is a real answer on the form. Guessing the cheapest engine is
    // how you end up eating the difference.
    for (const engineType of ["not sure", "unsure", "", null, "jet"]) {
      expect(spoil({ engineType }), String(engineType)).toMatchObject({
        reason: "unknown_engine_type",
      });
    }
  });

  it("declines any hint of Care work", () => {
    for (const text of [
      "Also want a full detail before spring",
      "interested in ceramic coating",
      "needs gelcoat restoration",
      "can you wet sand the hull",
      "bottom paint too please",
    ]) {
      expect(spoil({ freeText: text }), text).toMatchObject({ reason: "care_service_interest" });
    }
  });

  it("declines anything implying a haul-out", () => {
    for (const text of [
      "Boat is in the water at the marina",
      "it's on a lift right now",
      "will you haul out from the slip",
      "currently moored",
    ]) {
      expect(spoil({ freeText: text }), text).toMatchObject({ reason: "in_water_complication" });
    }
  });

  it("declines beyond-band transport", () => {
    // The transport half would be unpriced, and a customer must never pay a
    // deposit against a partial total.
    expect(spoil({ transportBand: "beyond" })).toMatchObject({ reason: "transport_beyond_band" });
  });

  it("declines a service this company's catalog does not sell", () => {
    expect(spoil({ requestedServiceKeys: ["outdoor_storage", "helicopter_lift"] })).toMatchObject({
      reason: "unpriceable_service",
    });
  });

  it("declines when nothing was actually requested", () => {
    expect(spoil({ requestedServiceKeys: [] })).toMatchObject({ reason: "no_services_requested" });
  });

  it("never quotes the same lead twice", () => {
    expect(spoil({ alreadyQuoted: true })).toMatchObject({ reason: "already_quoted" });
  });
});

describe("every decline explains itself", () => {
  it("carries a reason and a human detail for the review list", () => {
    const cases: Array<Partial<AutoQuoteCandidate>> = [
      { enabled: false },
      { formType: "contact" },
      { companyId: null },
      { catalog: null },
      { boatLengthFt: null },
      { boatLengthFt: 300 },
      { engineType: "not sure" },
      { freeText: "wants a detail" },
      { freeText: "boat is in the water" },
      { transportBand: "beyond" },
      { requestedServiceKeys: ["nope"] },
      { requestedServiceKeys: [] },
      { alreadyQuoted: true },
    ];
    for (const over of cases) {
      const d = spoil(over);
      expect(d.eligible, JSON.stringify(over)).toBe(false);
      expect(d.reason, JSON.stringify(over)).toBeTruthy();
      expect((d.detail ?? "").length, JSON.stringify(over)).toBeGreaterThan(5);
    }
  });
});

describe("confirmation copy follows the decision", () => {
  it("promises the quote is ready only when it actually is", () => {
    expect(confirmationVariant({ eligible: true })).toBe("instant_quote");
    expect(confirmationVariant({ eligible: false, reason: "care_service_interest" })).toBe("quote_coming");
  });
});

/**
 * Case and phrasing vary; the guard has to survive how people actually type.
 */
describe("free-text matching is not brittle", () => {
  it("matches regardless of case", () => {
    expect(spoil({ freeText: "CERAMIC COATING please" })).toMatchObject({
      reason: "care_service_interest",
    });
  });

  it("does not fire on unrelated text", () => {
    expect(spoil({ freeText: "24ft bowrider, trailer included, thanks!" }).eligible).toBe(true);
  });

  it("tolerates an empty message", () => {
    expect(spoil({ freeText: "" }).eligible).toBe(true);
  });
});
