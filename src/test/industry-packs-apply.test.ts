import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * applyIndustryPack against an in-memory store whose query builder honours .eq() filters,
 * so tenancy (organization_id scoping) is exercised for real through the service's own
 * queries and the real assertCompanyInOrganization.
 */

type Row = Record<string, unknown>;
const store: Record<string, Row[]> = { companies: [], service_catalog_items: [], workflows: [] };
let nextId = 1;
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let op: "select" | "update" | "insert" = "select";
  let patch: Row = {};
  let payload: Row = {};

  const run = (): Row[] => {
    const rows = store[table] ?? (store[table] = []);
    if (op === "insert") {
      const row = { id: uuid(), active: true, sort_order: 0, tiers: null, rate_bands: null, ...payload };
      rows.push(row);
      return [row];
    }
    const matched = rows.filter((row) => filters.every((f) => f(row)));
    if (op === "update") for (const row of matched) Object.assign(row, patch);
    return matched.map((r) => ({ ...r }));
  };

  const api = {
    select: () => api,
    eq: (col: string, value: unknown) => (filters.push((row) => row[col] === value), api),
    is: (col: string, value: unknown) => (filters.push((row) => (row[col] ?? null) === value), api),
    order: () => api,
    update: (p: Row) => ((op = "update"), (patch = p), api),
    insert: (p: Row) => ((op = "insert"), (payload = p), api),
    single: () => {
      const rows = run();
      return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: new Error(`${table}: no row`) });
    },
    maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data: run(), error: null }),
  };
  return api;
}

function ctx(organizationId: string) {
  return { organizationId, actorProfileId: "user-1", supabase: { from: (t: string) => query(t) } } as never;
}

// createWorkflow / updateWorkflow write the same store (scoped by org, like the real ones).
vi.mock("@/server/services/workflows", () => ({
  createWorkflow: (context: { organizationId: string }, input: Row) => {
    const row = {
      id: uuid(),
      organization_id: context.organizationId,
      company_id: input.companyId,
      slug: input.slug,
      name: input.name,
      status: input.status ?? "active",
      definition: JSON.parse(JSON.stringify(input.definition)),
    };
    store.workflows.push(row);
    return Promise.resolve(row);
  },
  updateWorkflow: (context: { organizationId: string }, input: { workflowId: string; definition?: Row }) => {
    const row = store.workflows.find((w) => w.id === input.workflowId && w.organization_id === context.organizationId);
    if (!row) return Promise.reject(new Error("not found"));
    if (input.definition) row.definition = JSON.parse(JSON.stringify(input.definition));
    return Promise.resolve(row);
  },
}));
vi.mock("@/server/outbound/sms", () => ({ isSmsSendConfigured: () => true }));
vi.mock("@/server/outbound/email", () => ({ isEmailSendConfigured: () => true }));
vi.mock("@/server/services/voice", () => ({ isVoiceConfigured: () => false }));

import { applyIndustryPack, listIndustryPacks } from "@/server/services/packs/apply";
import { getPack } from "@/server/services/packs";
import { updateCatalogItemPrices } from "@/server/services/quotes/catalog-items";
import { getRecipe } from "@/server/services/workflow-engine/recipes";

const ORG = "org-a";
const OTHER_ORG = "org-b";
let COMPANY = "";

function stockInstall(slug: string, extra: Row = {}) {
  const recipe = getRecipe(slug)!;
  const row = {
    id: uuid(),
    organization_id: ORG,
    company_id: COMPANY,
    slug,
    status: recipe.default_status,
    definition: { ...JSON.parse(JSON.stringify(recipe.definition)), ...extra },
  };
  store.workflows.push(row);
  return row;
}

beforeEach(() => {
  for (const k of Object.keys(store)) store[k] = [];
  nextId = 1;
  COMPANY = uuid();
  store.companies.push({ id: COMPANY, organization_id: ORG, name: "Bayside Snow", booking_policy: null, industry_pack: null });
});

describe("applyIndustryPack", () => {
  it("creates the pack's services price-less and inactive, installs its recipes, and records the pack", async () => {
    const pack = getPack("property-maintenance-snow")!;
    const report = await applyIndustryPack(ctx(ORG), COMPANY, pack.id);

    expect(report.services.created).toHaveLength(pack.services.length);
    const items = store.service_catalog_items.filter((i) => i.company_id === COMPANY);
    expect(items).toHaveLength(pack.services.length);
    for (const item of items) {
      expect(item).toMatchObject({ organization_id: ORG, rate_cents: 0, minimum_cents: 0, active: false });
    }
    expect(report.needsPrices.map((n) => n.label).sort()).toEqual(pack.services.map((s) => s.label).sort());

    expect(report.recipes.installed.map((r) => r.slug).sort()).toEqual(pack.recipes.map((r) => r.slug).sort());
    const missed = store.workflows.find((w) => w.slug === "missed-call-text-back")!;
    expect(JSON.stringify(missed.definition)).toContain("missed plow");
    expect((missed.definition as Row)._pack).toMatchObject({ id: pack.id, version: pack.version });

    const company = store.companies[0];
    expect(company.industry_pack).toMatchObject({ id: pack.id, version: pack.version });
    expect((company.industry_pack as { recipes: string[] }).recipes).toHaveLength(pack.recipes.length);
    expect(company.booking_policy).toBeNull(); // booking windows are opt-in
    expect(report.bookingPolicy).toBe("not_requested");
  });

  it("is idempotent: a second run creates nothing and reports everything unchanged", async () => {
    await applyIndustryPack(ctx(ORG), COMPANY, "roofing");
    const itemsBefore = store.service_catalog_items.length;
    const workflowsBefore = JSON.stringify(store.workflows);

    const second = await applyIndustryPack(ctx(ORG), COMPANY, "roofing");
    expect(second.services.created).toHaveLength(0);
    expect(second.services.skipped).toHaveLength(getPack("roofing")!.services.length);
    expect(second.recipes.installed).toHaveLength(0);
    expect(second.recipes.updated).toHaveLength(0);
    expect(second.recipes.unchanged).toHaveLength(getPack("roofing")!.recipes.length);
    expect(store.service_catalog_items).toHaveLength(itemsBefore);
    expect(JSON.stringify(store.workflows)).toBe(workflowsBefore);
  });

  it("skips services the company already has, by label (any case) or service key", async () => {
    store.service_catalog_items.push(
      { id: uuid(), organization_id: ORG, company_id: COMPANY, service_key: "custom", label: "FALL CLEANUP", rate_cents: 5000, minimum_cents: 0, active: true, sort_order: 3, tiers: null, rate_bands: null, pricing_type: "flat", unit_label: null },
      { id: uuid(), organization_id: ORG, company_id: COMPANY, service_key: "salting_residential", label: "Salt it", rate_cents: 0, minimum_cents: 0, active: true, sort_order: 4, tiers: null, rate_bands: null, pricing_type: "flat", unit_label: null },
    );
    const report = await applyIndustryPack(ctx(ORG), COMPANY, "property-maintenance-snow", { recipes: "none" });
    expect(report.services.skipped.map((s) => s.label)).toEqual(
      expect.arrayContaining(["Fall cleanup", "Salting — driveway and walkway"]),
    );
    // The pre-existing unpriced item is flagged too; the priced one is not.
    expect(report.needsPrices.map((n) => n.label)).toContain("Salt it");
    expect(report.needsPrices.map((n) => n.label)).not.toContain("FALL CLEANUP");
    expect(report.recipes.installed).toHaveLength(0);
  });

  it("tailors stock recipes (keeping _disabled_reason) but never overwrites one the owner edited", async () => {
    const stock = stockInstall("booking-reminder", { _disabled_reason: "Needs sms configured before it can run." });
    const edited = stockInstall("missed-call-text-back");
    (edited.definition as { actions: Array<{ body: string }> }).actions[0].body = "Owner's own words from {{company.name}}";
    const editedBefore = JSON.stringify(edited.definition);

    const report = await applyIndustryPack(ctx(ORG), COMPANY, "hvac-plumbing");

    expect(report.recipes.updated.map((u) => u.slug)).toContain("booking-reminder");
    const tailored = store.workflows.find((w) => w.id === stock.id)!.definition as Row;
    expect(JSON.stringify(tailored)).toContain("technician");
    expect(tailored._disabled_reason).toBe("Needs sms configured before it can run.");

    expect(report.recipes.skippedOwnerEdited).toEqual([{ slug: "missed-call-text-back", workflowId: edited.id }]);
    expect(JSON.stringify(store.workflows.find((w) => w.id === edited.id)!.definition)).toBe(editedBefore);
  });

  it("re-applies over its own untouched output (e.g. a newer pack version) but not over an edit made after it", async () => {
    await applyIndustryPack(ctx(ORG), COMPANY, "landscaping", { services: false });
    const review = store.workflows.find((w) => w.slug === "review-request")!;
    // Simulate an older pack version: different content, stamped with its own fingerprint.
    const { definitionFingerprint } = await import("@/server/services/packs/apply");
    const older = JSON.parse(JSON.stringify(review.definition)) as { actions: Array<{ body?: string }>; _pack: Row };
    older.actions[1].body = "Old v0 wording from {{company.name}}";
    older._pack = { id: "landscaping", version: 0, fingerprint: definitionFingerprint(older) };
    review.definition = older;

    const again = await applyIndustryPack(ctx(ORG), COMPANY, "landscaping", { services: false });
    expect(again.recipes.updated.map((u) => u.slug)).toEqual(["review-request"]);

    // Now the owner edits it — the next apply leaves it alone.
    (review.definition as { actions: Array<{ body?: string }> }).actions[1].body = "My review ask {{company.name}}";
    const third = await applyIndustryPack(ctx(ORG), COMPANY, "landscaping", { services: false });
    expect(third.recipes.skippedOwnerEdited.map((s) => s.slug)).toEqual(["review-request"]);
  });

  it("applies the review timing to review-request's wait", async () => {
    await applyIndustryPack(ctx(ORG), COMPANY, "general-contractor", { services: false, recipes: ["review-request"] });
    const review = store.workflows.find((w) => w.slug === "review-request")!;
    expect((review.definition as { actions: Row[] }).actions[0]).toMatchObject({ type: "wait", duration: "5d" });
    expect(store.workflows).toHaveLength(1);
  });

  it("sets booking windows only on request and never over an existing policy", async () => {
    const first = await applyIndustryPack(ctx(ORG), COMPANY, "hvac-plumbing", { services: false, recipes: "none", bookingPolicy: true });
    expect(first.bookingPolicy).toBe("applied");
    expect(store.companies[0].booking_policy).toEqual(getPack("hvac-plumbing")!.booking);

    store.companies[0].booking_policy = { mode: "windows", capacityPerWindow: 9 };
    const second = await applyIndustryPack(ctx(ORG), COMPANY, "roofing", { services: false, recipes: "none", bookingPolicy: true });
    expect(second.bookingPolicy).toBe("kept_existing");
    expect(store.companies[0].booking_policy).toEqual({ mode: "windows", capacityPerWindow: 9 });
  });

  it("is tenant-scoped: another org cannot apply a pack to this company", async () => {
    await expect(applyIndustryPack(ctx(OTHER_ORG), COMPANY, "roofing")).rejects.toThrow(/does not belong/);
    expect(store.service_catalog_items).toHaveLength(0);
    expect(store.workflows).toHaveLength(0);
    expect(store.companies[0].industry_pack).toBeNull();
  });

  it("rejects an unknown pack", async () => {
    await expect(applyIndustryPack(ctx(ORG), COMPANY, "underwater-basket-weaving")).rejects.toThrow(/Unknown industry pack/);
  });
});

describe("listIndustryPacks + updateCatalogItemPrices", () => {
  it("lists packs without prices, shows the applied pack, and pricing an item switches it on", async () => {
    await applyIndustryPack(ctx(ORG), COMPANY, "marine", { recipes: "none" });
    const listing = await listIndustryPacks(ctx(ORG), COMPANY);
    expect(listing.packs.map((p) => p.id)).toContain("marine");
    // No price-bearing keys and no dollar amounts in what the picker receives.
    expect(JSON.stringify(listing.packs)).not.toMatch(/"\w*(cents|rate|price|amount)\w*"\s*:/i);
    expect(JSON.stringify(listing.packs)).not.toMatch(/\$\s?\d/);
    expect(listing.applied).toMatchObject({ id: "marine", version: 1 });

    const first = listing.needsPrices[0];
    await updateCatalogItemPrices(ctx(ORG), { companyId: COMPANY, items: [{ id: first.id, rateCents: 4200 }] });
    const item = store.service_catalog_items.find((i) => i.id === first.id)!;
    expect(item).toMatchObject({ rate_cents: 4200, active: true });

    const after = await listIndustryPacks(ctx(ORG), COMPANY);
    expect(after.needsPrices.map((n) => n.id)).not.toContain(first.id);
  });

  it("will not price another org's catalog item", async () => {
    await applyIndustryPack(ctx(ORG), COMPANY, "marine", { recipes: "none" });
    const id = store.service_catalog_items[0].id as string;
    await expect(
      updateCatalogItemPrices(ctx(OTHER_ORG), { companyId: COMPANY, items: [{ id, rateCents: 100 }] }),
    ).rejects.toThrow();
    expect(store.service_catalog_items[0].rate_cents).toBe(0);
  });
});
