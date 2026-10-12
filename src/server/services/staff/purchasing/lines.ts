/**
 * The materials list for a job, from its quote (docs/ai-staff.md → "Purchasing"):
 *
 *   1. What was sold: the quote's price-list services (input_snapshot.services, with the
 *      customer's optional-line choices from approved_line_items when the quote was approved) and
 *      how many units of each — per_unit items count `quantity`, per-measure items their measure
 *      (sq ft, squares, feet…), flat items 1.
 *   2. Recipes: material_recipes lines per catalog item × those units, rounded UP to whole units
 *      (you can't buy 21.6 bundles), same label + unit merged.
 *   3. What's left over (services with no recipe, and custom lines) is what the AI estimate covers
 *      when it's on (ai.ts) — clearly marked "estimate".
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, MaterialRecipeRow, PoLine } from "./db-types";

export interface QuoteService {
  serviceKey: string;
  label: string;
  units: number;
  catalogItemId: string | null;
}

export interface QuoteForMaterials {
  id: string;
  title: string | null;
  services: QuoteService[];
  /** Hand-priced lines + price-list lines with no recipe (for the AI estimate). */
  uncovered: Array<{ label: string; description: string | null; quantity: number }>;
}

interface QuoteRow {
  id: string;
  title: string | null;
  company_id: string | null;
  input_snapshot: unknown;
  line_items: unknown;
  approved_line_items: unknown;
}

interface CatalogRow {
  id: string;
  service_key: string;
  label: string;
  pricing_type: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const MEASURE_TYPES = new Set(["per_measure", "per_measure_banded", "tiered_by_measure"]);

function positive(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Units of a catalog item on a quote line ("how many of the thing we sold"). PURE. */
export function unitsOf(service: Record<string, unknown>, pricingType: string | null): number {
  if (pricingType && MEASURE_TYPES.has(pricingType)) return positive(service.lengthFt) ?? positive(service.measure) ?? 1;
  if (pricingType === "flat") return 1;
  return positive(service.quantity) ?? positive(service.engineCount) ?? 1;
}

/**
 * Which services the customer ended up with: every required one, plus optional ones they ticked
 * (approved_line_items when approved, else the stored line_items' `selected`). PURE.
 */
export function selectedServiceKeys(snapshotServices: Array<Record<string, unknown>>, lineItems: unknown, approvedLineItems: unknown): Set<string> {
  const decided = Array.isArray(approvedLineItems) ? approvedLineItems : Array.isArray(lineItems) ? lineItems : [];
  const selectedOf = new Map<string, boolean>();
  for (const raw of decided) {
    const l = record(raw);
    if (typeof l.serviceId === "string" && l.serviceId !== "custom") selectedOf.set(l.serviceId, l.selected !== false);
  }
  const out = new Set<string>();
  for (const s of snapshotServices) {
    const key = typeof s.serviceId === "string" ? s.serviceId : null;
    if (!key) continue;
    const chosen = selectedOf.has(key) ? selectedOf.get(key) : s.optional === true ? s.selected === true : true;
    if (chosen) out.add(key);
  }
  return out;
}

/** The quote's sold services and its hand-priced lines (service role, scoped). */
export async function loadQuoteForMaterials(admin: AdminClient, scope: { organizationId: string; companyId: string }, quoteId: string): Promise<QuoteForMaterials | null> {
  const db = admin as Db;
  const { data, error } = await db
    .from("quotes")
    .select("id, title, company_id, input_snapshot, line_items, approved_line_items")
    .eq("organization_id", scope.organizationId)
    .eq("id", quoteId)
    .maybeSingle();
  if (error) throw error;
  const quote = data as QuoteRow | null;
  if (!quote || (quote.company_id && quote.company_id !== scope.companyId)) return null;
  const snapshot = record(quote.input_snapshot);
  const snapServices = (Array.isArray(snapshot.services) ? snapshot.services : []).map(record);
  const chosen = selectedServiceKeys(snapServices, quote.line_items, quote.approved_line_items);
  const keys = [...chosen];
  const catalog = new Map<string, CatalogRow>();
  if (keys.length) {
    const { data: items, error: catErr } = await db
      .from("service_catalog_items")
      .select("id, service_key, label, pricing_type")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .in("service_key", keys);
    if (catErr) throw catErr;
    for (const item of (items ?? []) as CatalogRow[]) catalog.set(item.service_key, item);
  }
  const services: QuoteService[] = [];
  for (const s of snapServices) {
    const key = typeof s.serviceId === "string" ? s.serviceId : null;
    if (!key || !chosen.has(key)) continue;
    const item = catalog.get(key) ?? null;
    services.push({ serviceKey: key, label: item?.label ?? key, units: unitsOf(s, item?.pricing_type ?? null), catalogItemId: item?.id ?? null });
  }
  const lineItems = Array.isArray(quote.approved_line_items) ? quote.approved_line_items : Array.isArray(quote.line_items) ? quote.line_items : [];
  const uncovered = lineItems
    .map(record)
    .filter((l) => l.custom === true && l.selected !== false && typeof l.label === "string")
    .map((l) => ({ label: String(l.label), description: typeof l.description === "string" ? l.description : null, quantity: positive(l.quantity) ?? 1 }));
  return { id: quote.id, title: quote.title, services, uncovered };
}

/** Recipe lines for these catalog items (service role, scoped), in order. */
export async function loadRecipes(admin: AdminClient, scope: { organizationId: string; companyId: string }, catalogItemIds: string[]): Promise<MaterialRecipeRow[]> {
  if (catalogItemIds.length === 0) return [];
  const { data, error } = await (admin as Db)
    .from("material_recipes")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .in("service_catalog_item_id", catalogItemIds)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as MaterialRecipeRow[];
}

/** Round a material amount UP to a whole unit (≥ 1). PURE. */
export function wholeUnits(qty: number): number {
  return Math.max(1, Math.ceil(qty - 1e-9));
}

export interface RecipeExpansion {
  lines: PoLine[];
  /** Per line, the supplier its recipe names (parallel to lines). */
  supplierIds: Array<string | null>;
  /** Services with no recipe (left for the AI estimate). */
  uncovered: QuoteService[];
}

/** Recipe lines × quote units, merged by label + unit. PURE. */
export function expandRecipes(services: QuoteService[], recipes: MaterialRecipeRow[]): RecipeExpansion {
  const byItem = new Map<string, MaterialRecipeRow[]>();
  for (const r of recipes) byItem.set(r.service_catalog_item_id, [...(byItem.get(r.service_catalog_item_id) ?? []), r]);
  const merged = new Map<string, { raw: number; line: PoLine; supplierId: string | null }>();
  const uncovered: QuoteService[] = [];
  for (const s of services) {
    const lines = s.catalogItemId ? byItem.get(s.catalogItemId) ?? [] : [];
    if (lines.length === 0) {
      uncovered.push(s);
      continue;
    }
    for (const r of lines) {
      const per = Number(r.qty_per_unit);
      if (!(per > 0)) continue;
      const key = `${r.label.trim().toLowerCase()}|${(r.unit ?? "").trim().toLowerCase()}`;
      const prev = merged.get(key);
      const raw = (prev?.raw ?? 0) + per * s.units;
      merged.set(key, {
        raw,
        supplierId: prev?.supplierId ?? r.supplier_id ?? null,
        line: { label: r.label.trim(), qty: 0, unit: r.unit?.trim() || null, estUnitCostCents: prev?.line.estUnitCostCents ?? r.est_unit_cost_cents ?? null, source: "recipe" },
      });
    }
  }
  const values = [...merged.values()];
  return {
    lines: values.map((v) => ({ ...v.line, qty: wholeUnits(v.raw) })),
    supplierIds: values.map((v) => v.supplierId),
    uncovered,
  };
}
