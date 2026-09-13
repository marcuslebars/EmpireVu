import { z } from "zod";

import type { Inserts, Tables } from "@/server/db/database.types";
import { slugify } from "@/server/db/helpers";
import { assertCompanyInOrganization, insertRow, type TenantServiceContext } from "@/server/services/shared";

/**
 * Catalog write path (Task 13). `catalog-repo.ts` is read-only pricing; the onboarding
 * Services step (and manual add/edit) needs to create/list/update service_catalog_items,
 * org+company scoped. `pricing_type` mirrors the app-level PricingType union.
 */

export const PRICING_TYPES = [
  "flat",
  "per_unit",
  "per_measure",
  "per_unit_declining",
  "tiered_by_measure",
  "per_measure_banded",
] as const;

export const catalogItemInputSchema = z.object({
  companyId: z.string().uuid(),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  pricingType: z.enum(PRICING_TYPES).default("flat"),
  rateCents: z.number().int().nonnegative().max(100_000_000).default(0),
  minimumCents: z.number().int().nonnegative().max(100_000_000).default(0),
  unitLabel: z.string().max(60).nullable().optional(),
  serviceKey: z.string().min(1).max(80).optional(),
});

export type CatalogItemInput = z.infer<typeof catalogItemInputSchema>;

export async function listCatalogItems(
  context: TenantServiceContext,
  companyId: string,
): Promise<Tables<"service_catalog_items">[]> {
  const { data, error } = await context.supabase
    .from("service_catalog_items")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Tables<"service_catalog_items">[];
}

export async function createCatalogItem(
  context: TenantServiceContext,
  input: CatalogItemInput,
): Promise<Tables<"service_catalog_items">> {
  await assertCompanyInOrganization(context, input.companyId);

  const serviceKey = (input.serviceKey ? slugify(input.serviceKey) : slugify(input.label)).slice(0, 80) || "service";
  const row: Inserts<"service_catalog_items"> = {
    organization_id: context.organizationId,
    company_id: input.companyId,
    label: input.label.trim(),
    description: input.description?.trim() || null,
    pricing_type: input.pricingType,
    service_key: serviceKey,
    rate_cents: input.rateCents,
    minimum_cents: input.minimumCents,
    unit_label: input.unitLabel?.trim() || null,
  };
  return insertRow(context, "service_catalog_items", row);
}
