/**
 * Form model for the quote builder: editable drafts of service and custom lines,
 * hydration from a saved quote's input_snapshot, and conversion to the API payload.
 * No pricing happens here — the server preview is the only source of prices.
 */
import type { QuoteWritePayload } from "@/lib/api-client";
import { inputKindFor, type CatalogItemSummary, type QuoteCatalog } from "@/lib/quotes-api";
import { centsToInput, parseDollarsToCents } from "@/components/invoices/invoice-ui";

export type ServicePayload = QuoteWritePayload["services"][number];
export type CustomLinePayload = NonNullable<QuoteWritePayload["customLines"]>[number];

/** Server limits (quotes route zod schema). */
export const LIMITS = {
  services: 20,
  customLines: 20,
  maxLengthFt: 100,
  maxDistanceKm: 2000,
  maxQuantity: 24,
  maxCustomAmountCents: 100_000_00,
} as const;

export interface ServiceDraft {
  key: number;
  serviceKey: string;
  measure: string;
  quantity: string;
  modifiers: Record<string, string>;
  optional: boolean;
  selected: boolean;
}

export interface CustomLineDraft {
  key: number;
  label: string;
  description: string;
  amount: string;
  optional: boolean;
  selected: boolean;
}

let seq = 0;
export const nextKey = () => ++seq;

export function newServiceDraft(item: CatalogItemSummary): ServiceDraft {
  return {
    key: nextKey(),
    serviceKey: item.serviceKey,
    measure: "",
    quantity: inputKindFor(item.pricingType) === "quantity" ? "1" : "",
    modifiers: {},
    optional: false,
    selected: false,
  };
}

export function newCustomLine(): CustomLineDraft {
  return { key: nextKey(), label: "", description: "", amount: "", optional: false, selected: false };
}

/** The unit label shown next to a measure input. */
export function measureUnit(item: CatalogItemSummary | undefined): string {
  return item?.unitLabel?.trim() || "ft";
}

function isKmUnit(item: CatalogItemSummary | undefined): boolean {
  return /km|kilomet/i.test(item?.unitLabel ?? "");
}

// ─── Hydration ───────────────────────────────────────────────────────────────

interface Snapshot {
  services: ServicePayload[];
  customLines: CustomLinePayload[];
  hullType: string;
  bundleId: string;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Read a stored input_snapshot ({services, customLines, hullType, bundleId}) defensively. */
export function readSnapshot(raw: unknown): Snapshot {
  const snap = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const services: ServicePayload[] = [];
  if (Array.isArray(snap.services)) {
    for (const s of snap.services) {
      if (!s || typeof s !== "object") continue;
      const r = s as Record<string, unknown>;
      if (typeof r.serviceId !== "string") continue;
      const modifiers: Record<string, string> = {};
      if (r.modifiers && typeof r.modifiers === "object") {
        for (const [k, v] of Object.entries(r.modifiers as Record<string, unknown>)) if (typeof v === "string") modifiers[k] = v;
      }
      services.push({
        serviceId: r.serviceId,
        lengthFt: num(r.lengthFt),
        distanceKm: num(r.distanceKm),
        // Older quotes counted engines; the catalog treats that as a quantity.
        quantity: num(r.quantity) ?? num(r.engineCount),
        optional: r.optional === true,
        selected: r.selected === true,
        modifiers,
      });
    }
  }
  const customLines: CustomLinePayload[] = [];
  if (Array.isArray(snap.customLines)) {
    for (const l of snap.customLines) {
      if (!l || typeof l !== "object") continue;
      const r = l as Record<string, unknown>;
      customLines.push({
        label: typeof r.label === "string" ? r.label : "",
        description: typeof r.description === "string" ? r.description : undefined,
        amountCents: num(r.amountCents) ?? 0,
        optional: r.optional === true,
        selected: r.selected === true,
      });
    }
  }
  return {
    services,
    customLines,
    hullType: typeof snap.hullType === "string" ? snap.hullType : "",
    bundleId: typeof snap.bundleId === "string" ? snap.bundleId : "",
  };
}

export function serviceDraftsFrom(services: ServicePayload[]): ServiceDraft[] {
  return services.map((s) => {
    const measure = s.lengthFt ?? s.distanceKm;
    return {
      key: nextKey(),
      serviceKey: s.serviceId,
      measure: measure !== undefined ? String(measure) : "",
      quantity: s.quantity !== undefined ? String(s.quantity) : "",
      modifiers: { ...(s.modifiers ?? {}) },
      optional: s.optional === true,
      selected: s.selected === true,
    };
  });
}

export function customDraftsFrom(lines: CustomLinePayload[]): CustomLineDraft[] {
  return lines.map((l) => ({
    key: nextKey(),
    label: l.label,
    // The pricing engine fills description with the label when blank; don't echo it back.
    description: l.description && l.description !== l.label ? l.description : "",
    amount: centsToInput(l.amountCents),
    optional: l.optional === true,
    selected: l.selected === true,
  }));
}

// ─── Validation + payload ────────────────────────────────────────────────────

/** Why one service line can't be priced yet, or null when it's complete. */
export function serviceProblem(d: ServiceDraft, item: CatalogItemSummary | undefined): string | null {
  if (!item) return "This service is no longer in the price list — remove it.";
  const kind = inputKindFor(item.pricingType);
  if (kind === "measure") {
    const m = Number(d.measure);
    const unit = measureUnit(item);
    if (!d.measure.trim() || !Number.isFinite(m) || m <= 0) return `Enter the ${unit}.`;
    // Over 100 is sent as distanceKm (see toServicePayload), so the API cap is 2000.
    const cap = Math.min(item.maxMeasure ?? LIMITS.maxDistanceKm, LIMITS.maxDistanceKm);
    if (m > cap) return `Maximum is ${cap} ${unit}.`;
  } else if (kind === "quantity") {
    const q = Number(d.quantity);
    const cap = Math.min(item.maxQuantity ?? LIMITS.maxQuantity, LIMITS.maxQuantity);
    if (!Number.isInteger(q) || q < 1 || q > cap) return `Quantity must be a whole number from 1 to ${cap}.`;
  }
  for (const g of item.modifierGroups) {
    if (g.required && !d.modifiers[g.key]) return `Choose a ${g.label.toLowerCase()}.`;
  }
  return null;
}

export function customLineProblem(l: CustomLineDraft): string | null {
  if (!l.label.trim()) return "Give this line a label.";
  const cents = parseDollarsToCents(l.amount);
  if (cents === null) return "Enter an amount (use 0 for no charge).";
  if (cents < 0) return "Amount can't be negative.";
  if (cents > LIMITS.maxCustomAmountCents) return "Amount is over the $100,000 limit.";
  return null;
}

export function toServicePayload(d: ServiceDraft, item: CatalogItemSummary): ServicePayload {
  const out: ServicePayload = { serviceId: d.serviceKey };
  const kind = inputKindFor(item.pricingType);
  if (kind === "measure") {
    const m = Number(d.measure);
    // Distances (km) and anything over the 100 ft cap go as distanceKm; both are "the measure" to the engine.
    if (isKmUnit(item) || m > LIMITS.maxLengthFt) out.distanceKm = m;
    else out.lengthFt = m;
  } else if (kind === "quantity") {
    out.quantity = Number(d.quantity);
  }
  const mods = Object.fromEntries(Object.entries(d.modifiers).filter(([, v]) => Boolean(v)));
  if (Object.keys(mods).length > 0) out.modifiers = mods;
  if (d.optional) {
    out.optional = true;
    out.selected = d.selected;
  }
  return out;
}

export function toCustomPayload(l: CustomLineDraft): CustomLinePayload {
  const out: CustomLinePayload = { label: l.label.trim(), amountCents: parseDollarsToCents(l.amount) ?? 0 };
  if (l.description.trim()) out.description = l.description.trim();
  if (l.optional) {
    out.optional = true;
    out.selected = l.selected;
  }
  return out;
}

export interface PricingInputs {
  services: ServicePayload[];
  customLines: CustomLinePayload[];
  hullType?: string;
  bundleId?: string;
}

/** The pricing part of the payload, or the first problem that stops it being priced. */
export function buildPricingInputs(
  catalog: QuoteCatalog | undefined,
  services: ServiceDraft[],
  customLines: CustomLineDraft[],
  hullType: string,
  bundleId: string,
): { inputs: PricingInputs | null; problem: string | null } {
  if (!catalog) return { inputs: null, problem: "Loading the price list…" };
  if (services.length + customLines.length === 0) return { inputs: null, problem: "Add a service or a custom line to see pricing." };
  const byKey = new Map(catalog.items.map((i) => [i.serviceKey, i]));
  const outServices: ServicePayload[] = [];
  for (const [i, d] of services.entries()) {
    const item = byKey.get(d.serviceKey);
    const p = serviceProblem(d, item);
    if (p || !item) return { inputs: null, problem: `${item?.label ?? `Service ${i + 1}`}: ${p ?? "unknown service"}` };
    outServices.push(toServicePayload(d, item));
  }
  const outCustom: CustomLinePayload[] = [];
  for (const [i, l] of customLines.entries()) {
    const p = customLineProblem(l);
    if (p) return { inputs: null, problem: `Custom line ${i + 1}: ${p}` };
    outCustom.push(toCustomPayload(l));
  }
  return {
    inputs: {
      services: outServices,
      customLines: outCustom,
      hullType: hullType || undefined,
      bundleId: bundleId || undefined,
    },
    problem: null,
  };
}
