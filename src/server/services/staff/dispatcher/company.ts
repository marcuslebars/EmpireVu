/**
 * The companies the Dispatcher works for, with their settings resolved (one batch read per
 * sweep). Service role; every later query is scoped by organization_id + company_id.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import type { Db } from "./db-types";
import { readDispatchSettings, type DispatchSettings } from "./settings";
import { zoneOf } from "./time";

export interface DispatchCompany {
  organizationId: string;
  companyId: string;
  /** The name customers know (brand_from_name, else the company name). */
  businessName: string;
  timeZone: string;
  platformBrand: string;
  crankleads: boolean;
  settings: DispatchSettings;
  latitude: number | null;
  longitude: number | null;
  locationCheckedAt: string | null;
  googlePlaceId: string | null;
  businessAddress: string | null;
  serviceArea: string | null;
  /** Base URL for customer links (/v/{manage_token}). */
  publicBaseUrl: string;
  ownerPhone: string | null;
}

const COLUMNS =
  "id, organization_id, name, brand_from_name, timezone, ai_settings, industry_pack, stage, latitude, longitude, location_checked_at, google_place_id, business_address, service_area, quote_public_base_url, owner_phone_e164";

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string;
  brand_from_name: string | null;
  timezone: string | null;
  ai_settings: unknown;
  industry_pack: unknown;
  stage: string | null;
  latitude: number | null;
  longitude: number | null;
  location_checked_at: string | null;
  google_place_id: string | null;
  business_address: string | null;
  service_area: string | null;
  quote_public_base_url: string | null;
  owner_phone_e164: string | null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** `.in()` over many ids, in URL-sized chunks. */
async function selectIn<T>(admin: AdminClient, table: string, columns: string, column: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await (admin as Db).from(table).select(columns).in(column, ids.slice(i, i + 150));
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

async function build(admin: AdminClient, rows: CompanyRow[]): Promise<DispatchCompany[]> {
  if (rows.length === 0) return [];
  const orgIds = [...new Set(rows.map((r) => r.organization_id))];
  const orgs = await selectIn<{ id: string; platform_brand: string | null }>(admin, "organizations", "id, platform_brand", "id", orgIds);
  const brandOf = new Map(orgs.map((o) => [o.id, o.platform_brand ?? "empirevu"]));
  // The CrankLeads business type is only a hint for companies without an industry pack.
  const needType = rows.filter((r) => brandOf.get(r.organization_id) === "crankleads" && !r.industry_pack).map((r) => r.id);
  const purchases = needType.length
    ? await selectIn<{ company_id: string | null; business_type: string | null }>(admin, "crankleads_purchases", "company_id, business_type", "company_id", needType).catch(() => [])
    : [];
  const typeOf = new Map(purchases.map((p) => [p.company_id, p.business_type]));
  return rows.map((r) => {
    const platformBrand = brandOf.get(r.organization_id) ?? "empirevu";
    const crankleads = platformBrand === "crankleads";
    return {
      organizationId: r.organization_id,
      companyId: r.id,
      businessName: text(r.brand_from_name) ?? r.name,
      timeZone: zoneOf(r.timezone),
      platformBrand,
      crankleads,
      settings: readDispatchSettings(r.ai_settings, { crankleads, industryPack: r.industry_pack, hints: [r.name, typeOf.get(r.id) ?? null] }),
      latitude: typeof r.latitude === "number" ? r.latitude : null,
      longitude: typeof r.longitude === "number" ? r.longitude : null,
      locationCheckedAt: r.location_checked_at ?? null,
      googlePlaceId: text(r.google_place_id),
      businessAddress: text(r.business_address),
      serviceArea: text(r.service_area),
      publicBaseUrl: quotePublicBaseUrlFor({ quote_public_base_url: r.quote_public_base_url, platform_brand: platformBrand }),
      ownerPhone: text(r.owner_phone_e164),
    };
  });
}

/** Every active company (paused / archived companies are left alone), settings resolved. */
export async function loadDispatchCompanies(admin: AdminClient): Promise<DispatchCompany[]> {
  const { data, error } = await (admin as Db).from("companies").select(COLUMNS).limit(5000);
  if (error) throw error;
  const rows = ((data ?? []) as CompanyRow[]).filter((r) => r.stage !== "paused" && r.stage !== "archived");
  return build(admin, rows);
}

/** One company, scoped to its organization. */
export async function loadDispatchCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<DispatchCompany | null> {
  const { data, error } = await (admin as Db).from("companies").select(COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return (await build(admin, [data as CompanyRow]))[0] ?? null;
}

/** The customer's private confirm / move / cancel page. */
export function manageUrl(company: Pick<DispatchCompany, "publicBaseUrl">, manageToken: string | null | undefined): string | null {
  return manageToken ? `${company.publicBaseUrl}/v/${manageToken}` : null;
}
