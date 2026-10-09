import { describe, expect, it, vi } from "vitest";

import type { CatalogItem, ServiceCatalog } from "@/server/services/quotes/catalog";
import type { QuoteRow } from "@/server/services/quotes/service";
import type { RetellFunctionRequest } from "@/server/services/retell/functions";
import {
  matchService,
  planPriceListQuote,
  runPriceListQuote,
  type PriceListQuoteArgs,
  type PriceListQuoteDeps,
} from "@/server/services/retell/tools/price-list-quote";

// The generic Front Desk quote tool: services by name → ONLY catalog items, asks when unsure,
// never invents a price.

function item(serviceKey: string, label: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return { serviceKey, label, pricingType: "flat", rateCents: 10000, minimumCents: 0, surchargeEligible: false, ...over };
}

const catalog: ServiceCatalog = {
  items: {
    furnace_tune_up: item("furnace_tune_up", "Furnace tune-up", { rateCents: 14900 }),
    ac_tune_up: item("ac_tune_up", "AC tune-up", { rateCents: 12900 }),
    drain_cleaning: item("drain_cleaning", "Drain cleaning", { rateCents: 18900 }),
    water_heater_flush: item("water_heater_flush", "Water heater flush", { rateCents: 9900 }),
    window_cleaning: item("window_cleaning", "Window cleaning", { pricingType: "per_unit", unitLabel: "window", rateCents: 800 }),
    eavestrough: item("eavestrough_cleaning", "Eavestrough cleaning", { pricingType: "per_measure", unitLabel: "foot", rateCents: 150 }),
    custom_install: item("custom_install", "Custom install", { modifierGroups: [{ key: "size", label: "Size", required: true, options: [] }] }),
  },
  bundles: {},
  surcharges: {},
};

describe("matchService", () => {
  it("exact name or key → matched", () => {
    expect(matchService(catalog, { name: "Furnace tune-up" })).toMatchObject({ status: "matched", item: { serviceKey: "furnace_tune_up" } });
    expect(matchService(catalog, { name: "drain_cleaning" })).toMatchObject({ status: "matched", item: { serviceKey: "drain_cleaning" } });
    expect(matchService(catalog, { name: "  DRAIN CLEANING!! " })).toMatchObject({ status: "matched", item: { serviceKey: "drain_cleaning" } });
  });

  it("one clear fuzzy match → matched (plurals, filler words)", () => {
    expect(matchService(catalog, { name: "clean my drains" })).toMatchObject({ status: "matched", item: { serviceKey: "drain_cleaning" } });
    expect(matchService(catalog, { name: "a water heater flush please" })).toMatchObject({ status: "matched", item: { serviceKey: "water_heater_flush" } });
  });

  it("several close candidates → ambiguous, with the options to ask about", () => {
    const m = matchService(catalog, { name: "tune-up" });
    expect(m.status).toBe("ambiguous");
    expect(m.status === "ambiguous" && m.options).toEqual(expect.arrayContaining(["Furnace tune-up", "AC tune-up"]));
  });

  it("nothing like it on the list → no_match (never a guess)", () => {
    expect(matchService(catalog, { name: "roof replacement" })).toEqual({ status: "no_match", requested: "roof replacement" });
    expect(matchService(catalog, { name: "" }).status).toBe("no_match");
  });

  it("per-unit / per-size items need the count / size first", () => {
    expect(matchService(catalog, { name: "window cleaning" })).toMatchObject({ status: "needs_detail", detail: "quantity", unitLabel: "window" });
    expect(matchService(catalog, { name: "window cleaning", quantity: 12 })).toMatchObject({ status: "matched", quantity: 12 });
    expect(matchService(catalog, { name: "eavestrough cleaning" })).toMatchObject({ status: "needs_detail", detail: "measure" });
    expect(matchService(catalog, { name: "eavestrough cleaning", measure: "120" })).toMatchObject({ status: "matched", measure: 120 });
  });

  it("items with required options are priced by the owner", () => {
    expect(matchService(catalog, { name: "custom install" }).status).toBe("owner_prices");
  });
});

describe("planPriceListQuote", () => {
  it("quotes only when EVERY line is certain", () => {
    expect(planPriceListQuote(catalog, [{ name: "furnace tune-up" }, { name: "drain cleaning" }])).toEqual({
      status: "ready",
      services: [{ serviceId: "furnace_tune_up" }, { serviceId: "drain_cleaning" }],
      labels: ["Furnace tune-up", "Drain cleaning"],
    });
    const clarify = planPriceListQuote(catalog, [{ name: "furnace tune-up" }, { name: "tune-up" }, { name: "window cleaning" }]);
    expect(clarify.status).toBe("clarify");
    expect(clarify.status === "clarify" && clarify.questions).toEqual([
      expect.stringMatching(/^For "tune-up", did you mean (Furnace tune-up|AC tune-up), or|did you mean .* or /),
      "How many windows for Window cleaning?",
    ]);
  });

  it("anything not on the list → no quote at all", () => {
    expect(planPriceListQuote(catalog, [{ name: "furnace tune-up" }, { name: "hot tub repair" }])).toEqual({
      status: "not_on_price_list",
      missing: ["hot tub repair"],
      matchedLabels: ["Furnace tune-up"],
    });
  });

  it("accepts a comma list and dedupes the same service", () => {
    expect(planPriceListQuote(catalog, "drain cleaning, drain cleaning")).toMatchObject({ status: "ready", services: [{ serviceId: "drain_cleaning" }] });
    expect(planPriceListQuote(catalog, []).status).toBe("no_services");
  });
});

function req(args: PriceListQuoteArgs): RetellFunctionRequest<PriceListQuoteArgs> {
  return {
    name: "quote_services",
    args,
    call: { callId: "call_1", fromNumber: "+17055550123", toNumber: "+17055550199", agentId: "agent_fd", direction: "inbound" },
    raw: { call: { call_id: "call_1", from_number: "+17055550123" }, args },
  };
}

function deps(over: Partial<PriceListQuoteDeps> = {}) {
  const quote = { id: "q1", quote_number: "Q-0001", subtotal_cents: 33800, contact_id: "c1", public_token: "tok" } as unknown as QuoteRow;
  const d = {
    resolveTenant: vi.fn(async () => ({ organizationId: "org", companyId: "co", sourceSite: "", resolvedBy: "agent" as const })),
    loadCatalog: vi.fn(async () => catalog),
    price: vi.fn(async () => ({ subtotalCents: 33800 })),
    captureLead: vi.fn(async () => ({ leadId: "lead_1", contactId: "c1" })),
    createAndSendQuote: vi.fn(async () => quote),
    textQuoteLink: vi.fn(async () => true),
    ...over,
  };
  return d;
}

describe("runPriceListQuote", () => {
  it("ready → lead, quote created + sent, link texted; says the catalog total", async () => {
    const d = deps();
    const res = await runPriceListQuote(req({ services: [{ name: "furnace tune-up" }, { name: "drain cleaning" }], caller_name: "Jamie Lee" }), d);
    expect(res).toMatchObject({ ok: true, quote_id: "q1", total_dollars: 338, texted: true });
    expect(res.say).toBe("That comes to $338 plus HST for Furnace tune-up and Drain cleaning. I've just texted the quote to the number you're calling from — you can approve it right from the link.");
    expect(d.createAndSendQuote).toHaveBeenCalledWith(
      { organizationId: "org", companyId: "co" },
      expect.objectContaining({ services: [{ serviceId: "furnace_tune_up" }, { serviceId: "drain_cleaning" }], leadId: "lead_1", contactId: "c1" }),
    );
    expect(d.textQuoteLink).toHaveBeenCalledWith({ organizationId: "org", companyId: "co" }, expect.objectContaining({ phone: "+17055550123" }));
  });

  it("a number the caller SAYS is kept on the lead, but the quote is only texted to the caller ID", async () => {
    const d = deps();
    const res = await runPriceListQuote(req({ services: [{ name: "drain cleaning" }], caller_name: "Jamie", phone: "416-555-0000" }), d);
    expect(res.ok).toBe(true);
    expect((d.captureLead.mock.calls[0] as unknown as [{ args: { phone: string } }])[0].args.phone).toBe("+14165550000");
    expect(d.textQuoteLink).toHaveBeenCalledTimes(1);
    expect(d.textQuoteLink).toHaveBeenCalledWith({ organizationId: "org", companyId: "co" }, expect.objectContaining({ phone: "+17055550123", contactId: null }));
  });

  it("no caller ID → no text at all (the team sends the link)", async () => {
    const d = deps();
    const r = req({ services: [{ name: "drain cleaning" }], caller_name: "Jamie", phone: "416-555-0000" });
    r.call.fromNumber = null as unknown as string;
    const res = await runPriceListQuote(r, d);
    expect(d.textQuoteLink).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, texted: false });
  });

  it("ambiguous → asks, creates NOTHING", async () => {
    const d = deps();
    const res = await runPriceListQuote(req({ services: [{ name: "tune-up" }], caller_name: "Jamie" }), d);
    expect(res).toMatchObject({ ok: false, reason: "clarify" });
    expect(d.captureLead).not.toHaveBeenCalled();
    expect(d.createAndSendQuote).not.toHaveBeenCalled();
  });

  it("not on the price list → files the lead, never invents a price", async () => {
    const d = deps();
    const res = await runPriceListQuote(req({ services: [{ name: "hot tub repair" }], caller_name: "Jamie" }), d);
    expect(res).toMatchObject({ ok: false, reason: "not_on_price_list" });
    expect(res.say).not.toMatch(/\$\d/);
    expect(d.captureLead).toHaveBeenCalledTimes(1);
    expect(d.createAndSendQuote).not.toHaveBeenCalled();
  });

  it("catalog refuses the combination → the owner prices it", async () => {
    const d = deps({ price: vi.fn(async () => { throw new Error("review rule"); }) });
    const res = await runPriceListQuote(req({ services: [{ name: "drain cleaning" }], caller_name: "Jamie" }), d);
    expect(res).toMatchObject({ ok: false, reason: "manual_review" });
    expect(d.createAndSendQuote).not.toHaveBeenCalled();
  });

  it("needs a name before filing anything", async () => {
    const d = deps();
    const res = await runPriceListQuote(req({ services: [{ name: "drain cleaning" }] }), d);
    expect(res).toMatchObject({ ok: false, reason: "missing_info" });
    expect(d.captureLead).not.toHaveBeenCalled();
  });

  it("an unmapped / legacy-guessed call is never priced", async () => {
    const d = deps({ resolveTenant: vi.fn(async () => ({ organizationId: "org", companyId: "co", sourceSite: "", resolvedBy: "legacy" as const })) });
    const res = await runPriceListQuote(req({ services: [{ name: "drain cleaning" }], caller_name: "Jamie" }), d);
    expect(res).toMatchObject({ ok: false, reason: "unsupported" });
    expect(d.loadCatalog).not.toHaveBeenCalled();
  });
});
