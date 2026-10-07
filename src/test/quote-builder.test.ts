import { describe, expect, it } from "vitest";
import { z } from "zod";

import careCatalogJson from "@/server/services/quotes/__fixtures__/a1-care-catalog.json";
import { readableZodMessage } from "@/server/api/route";
import type { ServiceCatalog } from "@/server/services/quotes/catalog";
import { priceQuote } from "@/server/services/quotes/pricing";
import { inputKindFor } from "@/lib/quotes-api";

const CARE = careCatalogJson as unknown as ServiceCatalog;

/**
 * The dashboard quote builder prices detailing — a per-foot service with a REQUIRED
 * tier choice. Before the builder, the quote layer dropped modifier choices on the
 * floor, so these services couldn't be quoted from the dashboard at all.
 */
describe("modifier choices reach the price", () => {
  const quote = (tier?: string) =>
    priceQuote({
      catalog: CARE,
      services: [{ serviceId: "exterior_detailing", lengthFt: 24, ...(tier ? { modifiers: { tier } } : {}) }],
      taxRateBps: 1300,
      depositRateBps: 2500,
      depositFlatCents: null,
    });

  it("a required tier with no choice is refused, not guessed", () => {
    expect(() => quote()).toThrow(/requires a choice/);
  });

  it("each tier scales the price", () => {
    const refresh = quote("refresh").subtotalCents;
    const deep = quote("deep").subtotalCents;
    expect(refresh).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(refresh);
  });

  it("an optional, unselected line is still priced (for its checkbox) with its choice", () => {
    const p = priceQuote({
      catalog: CARE,
      services: [
        { serviceId: "exterior_detailing", lengthFt: 24, modifiers: { tier: "refresh" } },
        { serviceId: "exterior_detailing", lengthFt: 24, modifiers: { tier: "deep" }, optional: true, selected: false },
      ],
      taxRateBps: 1300,
      depositRateBps: 2500,
      depositFlatCents: null,
    });
    const unselected = p.lineItems.find((l) => l.optional && !l.selected);
    expect(unselected?.amountCents).toBe(quote("deep").subtotalCents);
    expect(p.subtotalCents).toBe(quote("refresh").subtotalCents);
  });
});

describe("builder input kinds", () => {
  it("asks for a measurement, a count, or nothing by pricing type", () => {
    expect(inputKindFor("per_measure")).toBe("measure");
    expect(inputKindFor("tiered_by_measure")).toBe("measure");
    expect(inputKindFor("per_measure_banded")).toBe("measure");
    expect(inputKindFor("per_unit")).toBe("quantity");
    expect(inputKindFor("per_unit_declining")).toBe("quantity");
    expect(inputKindFor("flat")).toBe("none");
  });
});

describe("validation errors read like sentences", () => {
  it("names the field the way the form does, with no paths, indexes or JSON", () => {
    const schema = z.object({ services: z.array(z.object({ lengthFt: z.number().max(100) })) });
    const result = schema.safeParse({ services: [{ lengthFt: 120 }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = readableZodMessage(result.error);
      expect(msg).toBe("Length (ft) must be at most 100.");
      expect(msg).not.toContain("{");
      expect(msg).not.toMatch(/services|\.0\.|lengthFt/);
    }
  });

  it("says a missing field is required", () => {
    const schema = z.object({ services: z.array(z.object({ lengthFt: z.number() })) });
    const result = schema.safeParse({ services: [{}] });
    expect(result.success).toBe(false);
    if (!result.success) expect(readableZodMessage(result.error)).toBe("Length (ft) is required.");
  });

  it("keeps a refine() message we wrote for people", () => {
    const schema = z.object({ services: z.array(z.string()) }).refine((v) => v.services.length > 0, {
      message: "A quote needs at least one service or custom line.",
      path: ["services"],
    });
    const result = schema.safeParse({ services: [] });
    if (!result.success) expect(readableZodMessage(result.error)).toBe("A quote needs at least one service or custom line.");
  });
});
