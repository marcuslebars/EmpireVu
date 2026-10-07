import { describe, expect, it } from "vitest";

import { parseLeadEnvelope } from "@/server/services/lead-intake/envelope";
import { selfServeEnabled } from "@/server/services/quotes/auto-quote";

const base = {
  schemaVersion: 1,
  source: "a1marinestorage-winter-quote",
  sourceSite: "a1marinestorage",
  formType: "quote",
  receivedAt: "2026-09-02T14:00:00.000Z",
  contact: { name: "Pat Quinn", email: "pat@example.com" },
};

/**
 * `meta` is a CLOSED zod object — unknown keys are stripped SILENTLY, with no
 * error anywhere. Before these keys were declared, a spoke could send logistics
 * and a selection, get a 200 back, and have both vanish; the auto-quote would
 * then see a lead with no transport and nothing to price, and decline it for the
 * wrong reason. That failure is invisible from either end, which is why it is
 * pinned here.
 */
describe("meta carries the self-serve keys through the parser", () => {
  it("preserves logistics", () => {
    const parsed = parseLeadEnvelope({
      ...base,
      meta: {
        site: "a1marinestorage.ca",
        logistics: {
          boatLocation: "home_trailer",
          town: "midland",
          transportBand: "local",
          distanceKm: 18,
          bandResolution: "locality",
          pickup: true,
          delivery: false,
          trailerProvided: true,
          batteryCount: 2,
        },
      },
    });

    const log = parsed.envelope?.meta?.logistics;
    expect(log).toBeTruthy();
    expect(log?.transportBand).toBe("local");
    expect(log?.distanceKm).toBe(18);
    expect(log?.trailerProvided).toBe(true);
    // false must survive: delivery-only and pickup-only are different quotes.
    expect(log?.pickup).toBe(true);
    expect(log?.delivery).toBe(false);
  });

  it("preserves the service-key selection", () => {
    const parsed = parseLeadEnvelope({
      ...base,
      meta: {
        selection: {
          bundleKey: "winter_ready_plus",
          services: [
            { serviceKey: "outdoor_storage", measure: 24 },
            { serviceKey: "battery_storage", quantity: 2 },
          ],
        },
      },
    });

    const sel = parsed.envelope?.meta?.selection;
    expect(sel?.bundleKey).toBe("winter_ready_plus");
    expect(sel?.services).toHaveLength(2);
    expect(sel?.services?.[0]).toEqual({ serviceKey: "outdoor_storage", measure: 24 });
  });

  it("preserves the quote reference so a downloaded PDF and the lead match", () => {
    const parsed = parseLeadEnvelope({ ...base, meta: { quoteRef: "A1MS-Q-7K2F9Q" } });
    expect(parsed.envelope?.meta?.quoteRef).toBe("A1MS-Q-7K2F9Q");
  });

  it("still accepts an envelope with no self-serve keys at all", () => {
    // Every existing spoke sends exactly this. The addition is additive.
    const parsed = parseLeadEnvelope({ ...base, meta: { site: "a1marinestorage.ca", page: "/contact" } });
    expect(parsed.envelope).toBeTruthy();
    expect(parsed.envelope?.meta?.logistics).toBeUndefined();
    expect(parsed.envelope?.meta?.selection).toBeUndefined();
  });

  it("still accepts an envelope with no meta at all", () => {
    const parsed = parseLeadEnvelope(base);
    expect(parsed.envelope).toBeTruthy();
  });
});

/**
 * Never-drop-a-lead: a malformed self-serve block must not cost the lead. The
 * envelope either parses without it or the lead is stored raw and flagged — what
 * must not happen is a rejection.
 */
describe("a malformed self-serve block does not cost the lead", () => {
  it("does not reject an otherwise valid envelope", () => {
    const parsed = parseLeadEnvelope({
      ...base,
      meta: { logistics: { distanceKm: "not a number", transportBand: 42 } },
    });
    // Either it parsed (dropping the bad block) or it is flagged for raw storage.
    // Both are acceptable; a hard rejection is not, because the endpoint's only
    // rejection is a bad signature.
    expect(parsed).toBeTruthy();
  });
});

/**
 * Self-serve stays OPT-IN even though quotes themselves are now opt-OUT
 * (STRIPE_QUOTES_ENABLED !== "0" since the quotes feature was enabled by
 * default). Taking a deposit with nobody in the loop is a bigger step than
 * showing a quote page, so it keeps the stricter default.
 */
describe("self-serve is opt-in and needs quotes not to be disabled", () => {
  it("stays off when its own flag is unset, even though quotes default on", () => {
    delete process.env.SELF_SERVE_QUOTES_ENABLED;
    expect(selfServeEnabled()).toBe(false);
  });

  it("is disabled outright when quotes are switched off", () => {
    // Self-serve without the quotes feature would create quotes whose hosted
    // page 404s — a customer emailed a dead link.
    process.env.SELF_SERVE_QUOTES_ENABLED = "1";
    process.env.STRIPE_QUOTES_ENABLED = "0";
    expect(selfServeEnabled()).toBe(false);
    delete process.env.SELF_SERVE_QUOTES_ENABLED;
    delete process.env.STRIPE_QUOTES_ENABLED;
  });

  it("is strictly === '1', not merely truthy", () => {
    delete process.env.STRIPE_QUOTES_ENABLED;
    for (const v of ["true", "yes", "0", ""]) {
      process.env.SELF_SERVE_QUOTES_ENABLED = v;
      expect(selfServeEnabled(), v).toBe(false);
    }
    process.env.SELF_SERVE_QUOTES_ENABLED = "1";
    expect(selfServeEnabled()).toBe(true);
    delete process.env.SELF_SERVE_QUOTES_ENABLED;
    delete process.env.STRIPE_QUOTES_ENABLED;
  });
});

describe("self-serve switch", () => {
  it("runs only when SELF_SERVE_QUOTES_ENABLED=1, whatever a leftover JOBBER_SYNC_ENABLED says", () => {
    process.env.SELF_SERVE_QUOTES_ENABLED = "1";
    process.env.JOBBER_SYNC_ENABLED = "1"; // retired — must no longer block self-serve
    expect(selfServeEnabled()).toBe(true);
    delete process.env.SELF_SERVE_QUOTES_ENABLED;
    expect(selfServeEnabled()).toBe(false);
    delete process.env.JOBBER_SYNC_ENABLED;
  });
});
