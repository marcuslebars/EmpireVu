import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import golden from "@/server/services/quotes/__fixtures__/a1-care-shrink-wrap-golden.json";
import { priceFromCatalog, type CatalogItem, type ServiceCatalog } from "@/server/services/quotes/catalog";
import { priceQuote } from "@/server/services/quotes/pricing";
import { parseRetellFunctionBody } from "@/server/services/retell/functions";
import {
  parseEngineType,
  parseHullType,
  parseLengthFt,
  phoneQuoteSummary,
  planPhoneQuote,
  toCaptureLeadPayload,
} from "@/server/services/retell/tools/phone-quote";
import { runPhoneQuote, type PhoneQuoteDeps } from "@/server/services/retell/tools/run-phone-quote";
import type { QuoteRow } from "@/server/services/quotes/service";

// ── The Care catalog, read from the SEED itself ─────────────────────────────────
// Parsing the seed (rather than keeping a second copy of the rates) means this test
// fails if someone edits the SQL without the golden cases, or vice versa.

function sqlTuple(src: string): (string | number | boolean | null)[] {
  const out: (string | number | boolean | null)[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'";
          j += 2;
          continue;
        }
        if (src[j] === "'") break;
        s += src[j++];
      }
      out.push(s);
      i = j + 1;
    } else if (/[\s,]/.test(ch)) {
      i++;
    } else {
      let j = i;
      while (j < src.length && src[j] !== ",") j++;
      const tok = src.slice(i, j).trim();
      out.push(tok === "null" ? null : tok === "true" ? true : tok === "false" ? false : /^-?\d+(\.\d+)?$/.test(tok) ? Number(tok) : tok);
      i = j;
    }
  }
  return out;
}

function careCatalogFromSeed(): { catalog: ServiceCatalog; flatDepositCents: number | null } {
  const sql = readFileSync(join(process.cwd(), "supabase/seeds/a1-care-shrink-wrap.sql"), "utf8");
  const catalog: ServiceCatalog = { items: {}, bundles: {}, surcharges: {} };

  for (const m of sql.matchAll(/insert into public\.service_catalog_items \(([^)]*)\)\s*values \((.*)\)\s*\n\s*on conflict/g)) {
    const cols = m[1].split(",").map((c) => c.trim());
    const vals = sqlTuple(m[2]);
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    const item: CatalogItem = {
      serviceKey: String(row.service_key),
      label: String(row.label),
      pricingType: row.pricing_type as CatalogItem["pricingType"],
      rateCents: Number(row.rate_cents),
      minimumCents: Number(row.minimum_cents),
      unitLabel: (row.unit_label as string) ?? null,
      additionalUnitMultiplier: row.additional_unit_multiplier == null ? null : Number(row.additional_unit_multiplier),
      additionalUnitRounding: row.additional_unit_rounding === "cent" ? "cent" : "dollar",
      maxQuantity: row.max_quantity == null ? null : Number(row.max_quantity),
      maxMeasure: row.max_measure == null ? null : Number(row.max_measure),
      surchargeEligible: row.surcharge_eligible === true,
    };
    catalog.items[item.serviceKey] = item;
  }
  for (const m of sql.matchAll(/insert into public\.service_catalog_surcharges \([^)]*\)\s*values \((.*)\)\s*\n/g)) {
    const [, , variant, label, cents] = sqlTuple(m[1]);
    catalog.surcharges[String(variant)] = { variantKey: String(variant), label: String(label), perMeasureCents: Number(cents) };
  }
  const flat = sql.match(/quote_deposit_flat_cents = (\d+)/);
  return { catalog, flatDepositCents: flat ? Number(flat[1]) : null };
}

const { catalog: CARE, flatDepositCents } = careCatalogFromSeed();

describe("A1 Marine Care shrink-wrap catalog — parity with the Care site's calculator", () => {
  it("seeds the four services, both hull surcharges and the $250 deposit", () => {
    expect(Object.keys(CARE.items).sort()).toEqual([
      "shrink_wrap",
      "winterization_inboard",
      "winterization_outboard",
      "winterization_sterndrive",
    ]);
    expect(CARE.surcharges.pontoon.perMeasureCents).toBe(1600);
    expect(CARE.surcharges.tritoon.perMeasureCents).toBe(2000);
    expect(flatDepositCents).toBe(25000);
  });

  it.each(golden.cases.map((c) => [c] as const))("reproduces %o to the cent", (c) => {
    const plan = planPhoneQuote(
      {
        name: "Dana Lee",
        boat_length_ft: c.lengthFt,
        hull_type: c.hullType,
        winterization_engine: c.engine ?? "none",
        engine_count: c.engines ?? undefined,
      },
      CARE,
      "+17055551234",
    );
    if (c.review) {
      expect(plan.status).toBe("manual_review");
      return;
    }
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    const pricing = priceQuote({
      catalog: CARE,
      services: plan.services,
      hullType: plan.hullType,
      depositFlatCents: flatDepositCents,
    });
    expect(pricing.subtotalCents).toBe(c.subtotalCents);
    expect(pricing.depositCents).toBe(25000);
  });

  it("sends boats over 40 ft and under 8 ft to the owner instead of pricing them", () => {
    expect(planPhoneQuote({ name: "Dana Lee", boat_length_ft: 41, hull_type: "cruiser" }, CARE, "+17055551234")).toMatchObject({
      status: "manual_review",
      reasons: ["Boats over 40 ft are quoted individually"],
    });
    expect(planPhoneQuote({ name: "Dana Lee", boat_length_ft: 7, hull_type: "other" }, CARE, "+17055551234")).toMatchObject({
      status: "manual_review",
      reasons: ["Boat length under 8 ft"],
    });
  });
});

describe("catalog: additional-unit rounding", () => {
  const item = (rounding?: "dollar" | "cent"): ServiceCatalog => ({
    items: {
      w: {
        serviceKey: "w",
        label: "Winterization",
        pricingType: "per_unit_declining",
        rateCents: 44500,
        minimumCents: 0,
        additionalUnitMultiplier: 0.75,
        additionalUnitRounding: rounding,
        surchargeEligible: false,
      },
    },
    bundles: {},
    surcharges: {},
  });

  it("keeps the engine's whole-dollar rounding by default", () => {
    expect(priceFromCatalog({ catalog: item(), lines: [{ serviceKey: "w", quantity: 2 }] }).subtotalCents).toBe(77900);
  });

  it("rounds to the cent when the item says so ($445 + $333.75)", () => {
    expect(priceFromCatalog({ catalog: item("cent"), lines: [{ serviceKey: "w", quantity: 2 }] }).subtotalCents).toBe(77875);
  });
});

describe("pricing: fixed deposits", () => {
  const flat = (depositFlatCents: number | null | undefined) =>
    priceQuote({ catalog: CARE, services: [{ serviceId: "shrink_wrap", lengthFt: 24 }], depositFlatCents });

  it("takes the flat amount instead of the percentage", () => {
    const p = flat(25000);
    expect(p.depositCents).toBe(25000);
    expect(p.depositFlatCents).toBe(25000);
  });

  it("never asks for more than the total", () => {
    const p = flat(10_000_000);
    expect(p.depositCents).toBe(p.totalCents);
  });

  it("falls back to the percentage when there is no flat policy", () => {
    const p = flat(null);
    expect(p.depositFlatCents).toBeNull();
    // 25% of $672 + 13% HST, round-half-up.
    expect(p.depositCents).toBe(Math.floor((p.totalCents * 2500 + 5000) / 10000));
  });
});

describe("what Marina says", () => {
  it("reads the wrap first, the add-on second, then the total — like the Care site", () => {
    const plan = planPhoneQuote(
      { name: "Dana Lee", boat_length_ft: "24", hull_type: "Bowrider", winterization_engine: "twin outboards", engine_count: 2 },
      CARE,
      "+17055551234",
    );
    if (plan.status !== "ready") throw new Error(plan.status);
    const pricing = priceQuote({ catalog: CARE, services: plan.services, hullType: plan.hullType, depositFlatCents: 25000 });
    expect(
      phoneQuoteSummary({
        plan,
        lineItems: pricing.lineItems,
        subtotalCents: pricing.subtotalCents,
        depositCents: pricing.depositCents,
        depositIsFlat: true,
      }),
    ).toBe(
      "The shrink wrap for a 24-foot bowrider comes to $672, and winterization is $481.25. " +
        "That's $1153.25 all in, plus HST. A $250 deposit holds your date and comes straight off that.",
    );
  });

  it("folds the pontoon surcharge into the wrap price", () => {
    const plan = planPhoneQuote({ name: "Mike Rowe", boat_length_ft: 22, hull_type: "pontoon boat" }, CARE, "+17055559876");
    if (plan.status !== "ready") throw new Error(plan.status);
    const pricing = priceQuote({ catalog: CARE, services: plan.services, hullType: plan.hullType, depositFlatCents: 25000 });
    expect(
      phoneQuoteSummary({ plan, lineItems: pricing.lineItems, subtotalCents: pricing.subtotalCents, depositCents: 25000, depositIsFlat: true }),
    ).toMatch(/^The shrink wrap for a 22-foot pontoon comes to \$968\. That's \$968 all in, plus HST\./);
  });
});

describe("parsing what the caller said", () => {
  it("maps the transcript's words onto hulls, engines and feet", () => {
    expect(parseHullType("Sea-Doo")).toBe("pwc");
    expect(parseHullType("express cruiser")).toBe("cruiser");
    expect(parseHullType("something odd")).toBe("other");
    expect(parseEngineType("Mercruiser I/O")).toBe("sterndrive");
    expect(parseEngineType("none")).toBeNull();
    expect(parseLengthFt("about 24 feet")).toBe(24);
    expect(parseLengthFt(23.6)).toBe(24);
  });

  it("asks for what's missing instead of guessing", () => {
    expect(planPhoneQuote({ boat_length_ft: 24 }, CARE, null)).toEqual({
      status: "missing_info",
      missing: ["name", "phone"],
    });
  });

  it("skips winterization a company doesn't sell rather than failing the wrap", () => {
    const wrapOnly: ServiceCatalog = { ...CARE, items: { shrink_wrap: CARE.items.shrink_wrap } };
    const plan = planPhoneQuote(
      { name: "Dana Lee", boat_length_ft: 24, hull_type: "bowrider", winterization_engine: "outboard" },
      wrapOnly,
      "+17055551234",
    );
    expect(plan).toMatchObject({ status: "ready", winterization: null, services: [{ serviceId: "shrink_wrap", lengthFt: 24 }] });
  });

  it("files the lead in the intake's own field names", () => {
    const call = { callId: "call_1", fromNumber: "+17055551234", toNumber: "+17055550000", agentId: "agent_1", direction: "inbound" };
    const payload = toCaptureLeadPayload(
      { name: "Dana Lee", boat_length_ft: 24, hull_type: "bowrider", winterization_engine: "outboard", town: "Midland", boat_location: "driveway" },
      call,
      undefined,
      planPhoneQuote({ name: "Dana Lee", boat_length_ft: 24, hull_type: "bowrider", winterization_engine: "outboard" }, CARE, call.fromNumber),
    );
    expect(payload).toMatchObject({
      call: { call_id: "call_1", from_number: "+17055551234", to_number: "+17055550000" },
      args: {
        caller_name: "Dana Lee",
        boat_length_ft: 24,
        boat_type: "bowrider",
        engine_type: "outboard",
        boat_location: "driveway, Midland",
        services_requested: ["Mobile shrink wrap", "Winterization"],
      },
    });
  });
});

describe("parseRetellFunctionBody", () => {
  it("reads the trusted call context and the args envelope", () => {
    const req = parseRetellFunctionBody({
      name: "quote_shrink_wrap",
      args: { name: "Dana" },
      call: { call_id: "c1", from_number: "+1705", to_number: "+1706", agent_id: "a1", direction: "inbound" },
    });
    expect(req).toMatchObject({
      name: "quote_shrink_wrap",
      args: { name: "Dana" },
      call: { callId: "c1", fromNumber: "+1705", toNumber: "+1706", agentId: "a1", direction: "inbound" },
    });
  });

  it("accepts a bare-args body (Payload: args only)", () => {
    expect(parseRetellFunctionBody({ name: "Dana" })).toMatchObject({ args: { name: "Dana" }, call: { callId: null } });
  });
});

// ── The tool end to end, with the database swapped out ─────────────────────────

function fakeDeps(overrides: Partial<PhoneQuoteDeps> = {}) {
  const captured: unknown[] = [];
  const quoted: unknown[] = [];
  const deps: PhoneQuoteDeps = {
    resolveTenant: vi.fn(async () => ({
      organizationId: "org_1",
      companyId: "co_care",
      sourceSite: "a1marinecare",
      resolvedBy: "number" as const,
    })),
    loadCatalog: vi.fn(async () => CARE),
    captureLead: vi.fn(async (payload: unknown) => {
      captured.push(payload);
      return { leadId: "lead_1", contactId: "contact_1" };
    }),
    createAndSendQuote: vi.fn(async (_tenant, input) => {
      quoted.push(input);
      const pricing = priceQuote({ catalog: CARE, services: input.plan.services, hullType: input.plan.hullType, depositFlatCents: 25000 });
      return {
        id: "quote_1",
        quote_number: "Q-1042",
        line_items: pricing.lineItems,
        subtotal_cents: pricing.subtotalCents,
        deposit_cents: pricing.depositCents,
        deposit_flat_cents: 25000,
      } as unknown as QuoteRow;
    }),
    ...overrides,
  };
  return { deps, captured, quoted };
}

const REQ = (args: Record<string, unknown>) =>
  parseRetellFunctionBody({
    args,
    call: { call_id: "call_9", from_number: "+17055551234", to_number: "+17059961010", agent_id: "agent_care" },
  });

describe("runPhoneQuote", () => {
  it("files the lead, creates the quote, and answers with the sentence to read", async () => {
    const { deps, quoted } = fakeDeps();
    const res = await runPhoneQuote(REQ({ name: "Dana Lee", boat_length_ft: 24, hull_type: "bowrider" }), deps);
    expect(res).toMatchObject({
      ok: true,
      quote_id: "quote_1",
      quote_number: "Q-1042",
      total_dollars: 672,
      deposit_dollars: 250,
      line_items: [{ label: "Mobile shrink wrap", dollars: 672 }],
    });
    expect(res.say).toMatch(/\$672 all in, plus HST/);
    expect(quoted[0]).toMatchObject({ contactId: "contact_1", leadId: "lead_1" });
  });

  it("asks again without filing anything when the name or length is missing", async () => {
    const { deps } = fakeDeps();
    const res = await runPhoneQuote(REQ({ boat_length_ft: 24 }), deps);
    expect(res).toMatchObject({ ok: false, reason: "missing_info", missing: ["name"] });
    expect(deps.captureLead).not.toHaveBeenCalled();
  });

  it("files the lead but hands a 45-footer to the owner", async () => {
    const { deps } = fakeDeps();
    const res = await runPhoneQuote(REQ({ name: "Dana Lee", boat_length_ft: 45, hull_type: "cruiser" }), deps);
    expect(res).toMatchObject({ ok: false, reason: "manual_review", requires_manual_review: true });
    expect(deps.captureLead).toHaveBeenCalledOnce();
    expect(deps.createAndSendQuote).not.toHaveBeenCalled();
  });

  it("offers a callback on a line with no catalog, and still files the lead", async () => {
    const { deps } = fakeDeps({ loadCatalog: vi.fn(async () => null) });
    const res = await runPhoneQuote(REQ({ name: "Dana Lee", boat_length_ft: 24 }), deps);
    expect(res).toMatchObject({ ok: false, reason: "unsupported" });
    expect(deps.captureLead).toHaveBeenCalledOnce();
  });

  it("never prices for an unmapped number", async () => {
    const { deps } = fakeDeps({
      resolveTenant: vi.fn(async () => ({ organizationId: null, companyId: null, sourceSite: "" })),
    });
    const res = await runPhoneQuote(REQ({ name: "Dana Lee", boat_length_ft: 24 }), deps);
    expect(res).toMatchObject({ ok: false, reason: "unsupported" });
    expect(deps.loadCatalog).not.toHaveBeenCalled();
    expect(deps.createAndSendQuote).not.toHaveBeenCalled();
  });

  it("won't quote a brand's prices on a legacy (env-guessed) tenant, but still files the lead", async () => {
    const { deps } = fakeDeps({
      resolveTenant: vi.fn(async () => ({
        organizationId: "org_1",
        companyId: "co_storage",
        sourceSite: "a1marinestorage",
        resolvedBy: "legacy" as const,
      })),
    });
    const res = await runPhoneQuote(REQ({ name: "Dana Lee", boat_length_ft: 24 }), deps);
    expect(res).toMatchObject({ ok: false, reason: "unsupported" });
    expect(deps.loadCatalog).not.toHaveBeenCalled();
    expect(deps.captureLead).toHaveBeenCalledOnce();
  });

  it("turns a quote failure into a promise to follow up, not dead air", async () => {
    const { deps } = fakeDeps({
      createAndSendQuote: vi.fn(async () => {
        throw new Error("stripe down");
      }),
    });
    const res = await runPhoneQuote(REQ({ name: "Dana Lee", boat_length_ft: 24 }), deps);
    expect(res).toMatchObject({ ok: false, reason: "error" });
    expect(res.say).toMatch(/within the hour/);
  });

  it("still quotes when lead capture fails — the post-call webhook files the call anyway", async () => {
    const { deps } = fakeDeps({
      captureLead: vi.fn(async () => {
        throw new Error("intake down");
      }),
    });
    const res = await runPhoneQuote(REQ({ name: "Dana Lee", boat_length_ft: 24 }), deps);
    expect(res.ok).toBe(true);
  });
});
