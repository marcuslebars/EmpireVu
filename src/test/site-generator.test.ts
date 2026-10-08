import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/test/helpers/fake-supabase";

vi.mock("@/server/services/usage", () => ({ recordAiUsageSafe: vi.fn(async () => undefined) }));

const anthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

import { writeSiteCopy } from "@/server/ai/site-copy";
import { snowCompany } from "@/server/services/dfy/__fixtures__/sample-sites";
import { parseSiteContent, type SiteCopyModelOutput } from "@/server/services/dfy/site-content";
import {
  generatePendingSites,
  generateSite,
  hasEnoughSiteData,
  notifyPublishedSites,
  sitePublishedSms,
  updateSiteEdits,
  type SiteGeneratorDeps,
} from "@/server/services/dfy/site-generator";

const ORG = "org-1";
const usage = { responseId: "r1", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };

function company(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    ...snowCompany.company,
    timezone: "America/Toronto",
    owner_email: "owner@example.com",
    business_phone_kind: "cell",
    industry_pack: { id: "property-maintenance-snow", version: 1, appliedAt: "", recipes: [] },
    online_booking_settings: { enabled: true },
    quote_public_base_url: null,
    ...patch,
  };
}

function catalog(companyId: string) {
  return snowCompany.catalog.map((item, i) => ({ id: `item-${companyId}-${i}`, organization_id: ORG, company_id: companyId, active: true, ...item }));
}

function seedDb(extra: Record<string, Record<string, unknown>[]> = {}): FakeDb {
  return createFakeDb(
    {
      organizations: [{ id: ORG, platform_brand: "crankleads", crankleads_tier: "close", subscription_status: "active" }],
      companies: [company("c1")],
      service_catalog_items: [
        ...catalog("c1"),
        // An inactive priced row must never reach the page.
        { id: "inactive", organization_id: ORG, company_id: "c1", active: false, service_key: "secret", label: "Secret service", description: null, pricing_type: "flat", rate_cents: 99900, minimum_cents: 0, unit_label: null },
      ],
      public_form_keys: [],
      company_sites: [],
      setup_intakes: [],
      ...extra,
    },
    { company_sites: [["slug"], ["company_id"]] },
  );
}

const goodCopy: SiteCopyModelOutput = {
  headline: "Snow removal in Barrie",
  subhead: "Plowing, salting and shovelling. Call (705) 555-0142 or ask for a quote.",
  about: "Northshore Snow & Property plows, salts and shovels driveways and small lots across south Barrie.",
  serviceBlurbs: [{ key: "roof_snow", blurb: "Heavy snow taken off your roof." }],
  faqs: [
    { question: "What areas do you serve?", answer: "Barrie, Innisfil and Oro-Medonte." },
    { question: "Can I book online?", answer: "Yes. Tap Book online." },
    { question: "How do I get a quote?", answer: "Use the form on this page." },
  ],
};

function deps(over: Partial<SiteGeneratorDeps> = {}): Partial<SiteGeneratorDeps> {
  return {
    writeCopy: vi.fn(async () => ({ copy: goodCopy, usage })),
    deliver: vi.fn(async () => ({ status: "sent" as const, body: "" })),
    // 14:00 in Toronto.
    now: () => new Date("2026-10-08T18:00:00Z"),
    ...over,
  };
}

let db: FakeDb;
beforeEach(() => {
  db = seedDb();
  anthropicCreate.mockReset();
});

describe("generateSite", () => {
  it("builds content from facts with model copy, creates a form key, and stores the facts used", async () => {
    const d = deps();
    const out = await generateSite(db.client, "c1", { deps: d });
    expect(out.created).toBe(true);
    expect(out.site.slug).toBe("northshore-snow-and-property");
    expect(out.site.status).toBe("draft");
    expect(out.site.mode).toBe("full");
    const content = parseSiteContent(out.site.content)!;
    expect(content.copySource).toBe("ai");
    expect(content.copy.headline).toBe("Snow removal in Barrie");
    expect(content.factsUsed).toEqual(expect.arrayContaining(["phone", "serviceArea", "hours", "googleRating", "prices", "onlineBooking", "trade"]));
    expect(db.tables.public_form_keys).toHaveLength(1);
    // The copywriter never sees prices.
    const factsArg = JSON.stringify((d.writeCopy as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(factsArg).not.toMatch(/\$\d|549|6500/);
  });

  it("never shows a price that isn't an active catalog price", async () => {
    const out = await generateSite(db.client, "c1", { deps: deps() });
    const content = parseSiteContent(out.site.content)!;
    const prices = content.facts.services.map((s) => s.priceText).filter(Boolean);
    expect(prices).toEqual(["$549", "$65 / visit", "$35 / application", "$25 / visit", "$225"]);
    expect(JSON.stringify(content)).not.toContain("Secret service");
    expect(JSON.stringify(content)).not.toContain("$999");
  });

  it("falls back to template copy when the model fails or returns invalid output", async () => {
    const failing = await generateSite(db.client, "c1", { deps: deps({ writeCopy: vi.fn(async () => { throw new Error("overloaded"); }) }) });
    const c1 = parseSiteContent(failing.site.content)!;
    expect(c1.copySource).toBe("template");
    expect(c1.copy.headline).toBe("Snow removal and property maintenance in Barrie, Innisfil and Oro-Medonte");
    expect(c1.copyNotes[0]).toContain("overloaded");

    // Through the real copywriter with a mocked SDK: schema-invalid JSON → ZodError → template.
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    anthropicCreate.mockResolvedValue({ id: "r", model: "m", stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify({ headline: "x", faqs: [] }) }] });
    await expect(writeSiteCopy({})).rejects.toThrow();
    const invalid = await generateSite(db.client, "c1", { deps: deps({ writeCopy: writeSiteCopy }) });
    expect(parseSiteContent(invalid.site.content)!.copySource).toBe("template");
    vi.unstubAllEnvs();
  });

  it("parses valid model output through the real copywriter", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    anthropicCreate.mockResolvedValue({ id: "r", model: "m", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7 }, content: [{ type: "text", text: JSON.stringify(goodCopy) }] });
    const result = await writeSiteCopy({ businessName: "x" });
    expect(result.copy.headline).toBe("Snow removal in Barrie");
    expect(result.usage.usage.outputTokens).toBe(7);
    vi.unstubAllEnvs();
  });

  it("chooses price_page when the company has a website, and keeps slug, mode, edits and status on regenerate", async () => {
    db = seedDb({ companies: [company("c1", { website: "northshore.ca" })] });
    const first = await generateSite(db.client, "c1", { publish: true, deps: deps() });
    expect(first.site.mode).toBe("price_page");
    expect(first.site.status).toBe("published");
    await updateSiteEdits(db.client, "c1", { headline: "Plowing done right", showPrices: false, mode: "full" });
    const again = await generateSite(db.client, "c1", { deps: deps() });
    expect(again.created).toBe(false);
    expect(again.site.slug).toBe(first.site.slug);
    expect(again.site.status).toBe("published");
    expect(again.site.mode).toBe("full");
    const content = parseSiteContent(again.site.content)!;
    expect(content.edits.headline).toBe("Plowing done right");
    expect(content.settings.showPrices).toBe(false);
    expect(db.tables.company_sites).toHaveLength(1);
  });

  it("gives every company a unique slug", async () => {
    db = seedDb({ companies: [company("c1"), company("c2"), company("c3")], service_catalog_items: [] });
    const slugs = [];
    for (const id of ["c1", "c2", "c3"]) slugs.push((await generateSite(db.client, id, { deps: deps() })).site.slug);
    expect(slugs).toEqual(["northshore-snow-and-property", "northshore-snow-and-property-2", "northshore-snow-and-property-3"]);
  });
});

describe("sweep", () => {
  it("generates + publishes enriched CrankLeads companies once, and texts the owner once", async () => {
    db = seedDb({
      companies: [company("c1"), company("c2", { name: "Waiting Co" }), company("c3", { name: "Old Co", service_area: "Orillia" }), company("c4", { name: "Thin Co", service_area: null, hours: null })],
      service_catalog_items: catalog("c1"),
      setup_intakes: [
        { id: "i1", organization_id: ORG, company_id: "c1", status: "enriched" },
        { id: "i2", organization_id: ORG, company_id: "c2", status: "opened" },
      ],
    });
    const d = deps();
    const first = await generatePendingSites(db.client, { deps: d });
    // c1 (enriched) + c3 (no intake, enough data). c2 is still mid-intake; c4 has too little.
    expect(first.generated.map((g) => g.companyId).sort()).toEqual(["c1", "c3"]);
    expect(db.tables.company_sites.every((s) => s.status === "published")).toBe(true);
    const second = await generatePendingSites(db.client, { deps: d });
    expect(second.generated).toEqual([]);
    expect(db.tables.company_sites).toHaveLength(2);

    const sent1 = await notifyPublishedSites(db.client, { deps: d });
    const sent2 = await notifyPublishedSites(db.client, { deps: d });
    expect(sent1).toHaveLength(2);
    expect(sent2).toHaveLength(0);
    const deliver = d.deliver as ReturnType<typeof vi.fn>;
    expect(deliver).toHaveBeenCalledTimes(2);
    const call = deliver.mock.calls[0][0];
    expect(call).toMatchObject({ channel: "sms", to: "+17055550142", smsFrom: "platform", contactId: null });
    expect(call.body).toMatch(/^Your new page is live: \S+\/(s\/)?northshore-snow-and-property\. Want changes\? \S+\/settings\?section=website$/);
  });

  it("waits for daytime, and emails a landline owner instead of texting", async () => {
    db = seedDb({ companies: [company("c1", { business_phone_kind: "landline" })], setup_intakes: [{ id: "i1", organization_id: ORG, company_id: "c1", status: "enriched" }] });
    await generatePendingSites(db.client, { deps: deps() });
    const night = deps({ now: () => new Date("2026-10-08T04:00:00Z") }); // 00:00 Toronto
    expect(await notifyPublishedSites(db.client, { deps: night })).toEqual([]);
    expect(night.deliver).not.toHaveBeenCalled();
    const day = deps();
    const out = await notifyPublishedSites(db.client, { deps: day });
    expect(out).toEqual([{ companyId: "c1", channel: "email", status: "sent" }]);
    expect((day.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ channel: "email", to: "owner@example.com" });
  });

  it("ignores non-CrankLeads orgs and canceled ones", async () => {
    db = seedDb({
      organizations: [
        { id: ORG, platform_brand: "empirevu", subscription_status: "active" },
        { id: "org-2", platform_brand: "crankleads", subscription_status: "canceled" },
      ],
      companies: [company("c1"), { ...company("c2"), organization_id: "org-2" }],
      setup_intakes: [{ id: "i1", organization_id: ORG, company_id: "c1", status: "enriched" }],
    });
    expect((await generatePendingSites(db.client, { deps: deps() })).generated).toEqual([]);
  });

  it("enough-data rule and SMS wording", () => {
    expect(hasEnoughSiteData({ name: "A", owner_phone_e164: "+1", service_area: "Barrie", hours: null }, 0)).toBe(true);
    expect(hasEnoughSiteData({ name: "A", owner_phone_e164: null, service_area: "Barrie", hours: null }, 5)).toBe(false);
    expect(hasEnoughSiteData({ name: "A", owner_phone_e164: "+1", service_area: null, hours: null }, 3)).toBe(true);
    expect(hasEnoughSiteData({ name: "A", owner_phone_e164: "+1", service_area: null, hours: null }, 2)).toBe(false);
    expect(sitePublishedSms("https://p/x", "https://a/settings?section=website")).toBe("Your new page is live: https://p/x. Want changes? https://a/settings?section=website");
  });
});
