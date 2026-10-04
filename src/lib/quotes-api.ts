/**
 * Client API for the quote builder: a company's price list, live pricing previews,
 * one quote, and revise-and-resend. List/create/update/send/void live in api-client.ts.
 */
import { apiFetch, type QuoteSummary, type QuoteWritePayload } from "@/lib/api-client";

export type PricingType = "flat" | "per_unit" | "per_measure" | "per_unit_declining" | "tiered_by_measure" | "per_measure_banded";

export interface CatalogModifierGroup {
  key: string;
  label: string;
  required?: boolean;
  options: Array<{ key: string; label: string; multiplier: number }>;
}

export interface CatalogItemSummary {
  serviceKey: string;
  label: string;
  description: string | null;
  pricingType: PricingType;
  rateCents: number;
  minimumCents: number;
  unitLabel: string | null;
  maxQuantity: number | null;
  maxMeasure: number | null;
  surchargeEligible: boolean;
  modifierGroups: CatalogModifierGroup[];
}

export interface QuoteCatalog {
  configured: boolean;
  items: CatalogItemSummary[];
  bundles: Array<{ bundleKey: string; label: string; discountPct: number; serviceKeys: string[] }>;
  surcharges: Array<{ variantKey: string; label: string; perMeasureCents: number }>;
}

/** What an item needs from the user: a measurement (feet, km, hours…), a count, or nothing. */
export function inputKindFor(type: PricingType): "measure" | "quantity" | "none" {
  if (type === "per_measure" || type === "tiered_by_measure" || type === "per_measure_banded") return "measure";
  if (type === "per_unit" || type === "per_unit_declining") return "quantity";
  return "none";
}

export interface QuotePreviewLine {
  serviceId: string;
  label: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  optional: boolean;
  selected: boolean;
  custom: boolean;
}

export interface QuotePreview {
  currency: string;
  lineItems: QuotePreviewLine[];
  bundleId: string | null;
  bundleSavingsCents: number;
  subtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
  depositCents: number;
}

export interface QuoteListItem extends QuoteSummary {
  contact_id: string | null;
  company_id: string | null;
  /** The customer's link, on the brand's own quote domain. */
  public_url: string;
  contact_name: string | null;
  contact_email: string | null;
  invoice_id: string | null;
  invoice_status: string | null;
  first_viewed_at: string | null;
  approved_at: string | null;
  deposit_paid_at: string | null;
  superseded_by: string | null;
}

const base = (orgId: string) => `/api/organizations/${orgId}/quotes`;

export function fetchQuoteCatalog(orgId: string, companyId: string): Promise<QuoteCatalog> {
  return apiFetch<QuoteCatalog>(`${base(orgId)}/catalog?companyId=${encodeURIComponent(companyId)}`);
}

export function previewQuote(orgId: string, payload: QuoteWritePayload & { companyId: string }): Promise<QuotePreview> {
  return apiFetch<QuotePreview>(`${base(orgId)}/preview`, { method: "POST", body: JSON.stringify(payload) });
}

/** One quote (the raw row — no public_url / contact_name enrichment). */
export function fetchQuote(
  orgId: string,
  quoteId: string,
): Promise<QuoteSummary & { contact_id: string | null; company_id: string | null; input_snapshot: unknown }> {
  return apiFetch(`${base(orgId)}/${quoteId}`);
}

export function reissueQuote(orgId: string, quoteId: string, reason?: string): Promise<{ cancelled: QuoteSummary; successor: QuoteSummary }> {
  return apiFetch(`${base(orgId)}/${quoteId}/reissue`, { method: "POST", body: JSON.stringify({ reason }) });
}
