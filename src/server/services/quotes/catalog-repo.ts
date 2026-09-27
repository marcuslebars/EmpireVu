/**
 * Load a tenant's service catalog.
 *
 * The only I/O in the pricing path. `catalog.ts` stays pure so the golden
 * fixtures can price without a database; this is the thin layer that fetches what
 * they feed it.
 *
 * Read via the service role: a customer repricing their own quote on the public
 * page has no session, and the catalog is not sensitive — it is the price list
 * they are already looking at.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { CatalogBundle, CatalogItem, CatalogSurcharge, ServiceCatalog } from "./catalog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export class CatalogNotConfiguredError extends Error {
  constructor(readonly companyId: string) {
    super(
      `Company ${companyId} has no service catalog. Seed one before quoting — ` +
        `there is deliberately no fallback price list.`,
    );
    this.name = "CatalogNotConfiguredError";
  }
}

function toItem(row: Db): CatalogItem {
  return {
    serviceKey: row.service_key,
    label: row.label,
    description: row.description ?? null,
    pricingType: row.pricing_type,
    rateCents: Number(row.rate_cents ?? 0),
    minimumCents: Number(row.minimum_cents ?? 0),
    unitLabel: row.unit_label ?? null,
    additionalUnitMultiplier:
      row.additional_unit_multiplier == null ? null : Number(row.additional_unit_multiplier),
    additionalUnitRounding: row.additional_unit_rounding === "cent" ? "cent" : "dollar",
    tiers: Array.isArray(row.tiers)
      ? row.tiers.map((t: Db) => ({
          maxMeasure: t.maxMeasure == null ? null : Number(t.maxMeasure),
          rateCents: Number(t.rateCents),
        }))
      : null,
    rateBands: Array.isArray(row.rate_bands)
      ? row.rate_bands.map((b: Db) => ({
          maxMeasure: b.maxMeasure == null ? null : Number(b.maxMeasure),
          rateCents: Number(b.rateCents),
        }))
      : null,
    modifierGroups: Array.isArray(row.modifier_groups) ? row.modifier_groups : null,
    reviewRules: Array.isArray(row.review_rules) ? row.review_rules : null,
    maxQuantity: row.max_quantity == null ? null : Number(row.max_quantity),
    maxMeasure: row.max_measure == null ? null : Number(row.max_measure),
    surchargeEligible: row.surcharge_eligible === true,
  };
}

/**
 * Fetch the catalog for a company.
 *
 * Throws when the tenant has none. Deliberately NO fallback to another tenant's
 * catalog or to a built-in default: quoting a customer at prices their supplier
 * never set is worse than failing loudly at the point an operator can fix it.
 */
export async function loadCatalog(companyId: string): Promise<ServiceCatalog> {
  const db = createSupabaseAdminClient() as Db;

  const [items, bundles, surcharges] = await Promise.all([
    db.from("service_catalog_items").select("*").eq("company_id", companyId).eq("active", true),
    db.from("service_catalog_bundles").select("*").eq("company_id", companyId).eq("active", true),
    db.from("service_catalog_surcharges").select("*").eq("company_id", companyId).eq("active", true),
  ]);

  for (const res of [items, bundles, surcharges]) {
    if (res.error) throw res.error;
  }

  const itemRows: Db[] = items.data ?? [];
  if (itemRows.length === 0) throw new CatalogNotConfiguredError(companyId);

  const catalog: ServiceCatalog = { items: {}, bundles: {}, surcharges: {} };

  for (const row of itemRows) {
    catalog.items[row.service_key] = toItem(row);
  }
  for (const row of (bundles.data ?? []) as Db[]) {
    const bundle: CatalogBundle = {
      bundleKey: row.bundle_key,
      label: row.label,
      discountPct: Number(row.discount_pct),
      serviceKeys: Array.isArray(row.service_keys) ? row.service_keys : [],
    };
    catalog.bundles[row.bundle_key] = bundle;
  }
  for (const row of (surcharges.data ?? []) as Db[]) {
    const surcharge: CatalogSurcharge = {
      variantKey: row.variant_key,
      label: row.label,
      perMeasureCents: Number(row.per_measure_cents ?? 0),
    };
    catalog.surcharges[row.variant_key] = surcharge;
  }

  return catalog;
}

/**
 * The company's fixed-deposit policy in cents, or null for the percentage default.
 *
 * Fails toward the percentage: an unreadable policy must not block a quote, and the
 * percentage is what every tenant got before fixed deposits existed.
 */
export async function loadDepositFlatCents(companyId: string): Promise<number | null> {
  const db = createSupabaseAdminClient() as Db;
  const { data, error } = await db
    .from("companies")
    .select("quote_deposit_flat_cents")
    .eq("id", companyId)
    .maybeSingle();
  if (error) {
    console.error(`[quotes] could not read deposit policy for company ${companyId}:`, error.message ?? error);
    return null;
  }
  const flat = Number(data?.quote_deposit_flat_cents);
  return Number.isInteger(flat) && flat > 0 ? flat : null;
}

/** True when a tenant can quote at all. Gates admin UI without throwing. */
export async function hasCatalog(companyId: string): Promise<boolean> {
  try {
    await loadCatalog(companyId);
    return true;
  } catch {
    return false;
  }
}
