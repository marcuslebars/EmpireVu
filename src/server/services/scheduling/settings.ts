/**
 * Online booking — staff side, under the caller's session (RLS; every query also filters
 * organization_id): the brand's booking settings and what its booking page will offer.
 */
import { z } from "zod";

import { toJson } from "@/server/db/json";
import { ValidationError } from "@/server/organizations/context";
import { parseBookingPolicy } from "@/server/services/booking-windows";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { flatPrice, onlineBookingSettingsSchema, parseOnlineBookingSettings, type CatalogService, type OnlineBookingSettings } from "./rules";
import { bookingPageUrl } from "./urls";

export interface OnlineBookingSettingsView {
  companyId: string;
  settings: OnlineBookingSettings;
  bookingUrl: string;
  /** "windows" when the brand books by half-day window (its industry pack), else "hourly". */
  mode: "windows" | "hourly";
  windows: Array<{ key: string; label: string; start: string }>;
  stripeReady: boolean;
  services: { active: number; fixedPrice: number };
}

async function loadCompany(ctx: TenantServiceContext, companyId: string) {
  await assertCompanyInOrganization(ctx, companyId);
  const { data, error } = await ctx.supabase
    .from("companies")
    .select("id, online_booking_settings, booking_policy, quote_public_base_url, stripe_connected_account_id, stripe_charges_enabled")
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError("Company not found.");
  return data;
}

export async function getOnlineBookingSettings(ctx: TenantServiceContext, companyId: string): Promise<OnlineBookingSettingsView> {
  const company = await loadCompany(ctx, companyId);
  const { data: services, error } = await ctx.supabase
    .from("service_catalog_items")
    .select("id, label, description, pricing_type, rate_cents, minimum_cents, unit_label")
    .eq("organization_id", ctx.organizationId)
    .eq("company_id", companyId)
    .eq("active", true);
  if (error) throw error;
  const policy = parseBookingPolicy(company.booking_policy ?? null);
  return {
    companyId,
    settings: parseOnlineBookingSettings(company.online_booking_settings),
    bookingUrl: bookingPageUrl(company),
    mode: policy ? "windows" : "hourly",
    windows: policy ? policy.windows.map((w) => ({ key: w.key, label: w.spoken.replace(/^in the /, ""), start: w.start })) : [],
    stripeReady: Boolean(company.stripe_connected_account_id && company.stripe_charges_enabled),
    services: {
      active: (services ?? []).length,
      fixedPrice: ((services ?? []) as CatalogService[]).filter((s) => flatPrice(s) !== null).length,
    },
  };
}

export const updateOnlineBookingSettingsSchema = onlineBookingSettingsSchema.partial();

export async function updateOnlineBookingSettings(
  ctx: TenantServiceContext,
  companyId: string,
  input: z.infer<typeof updateOnlineBookingSettingsSchema>,
): Promise<OnlineBookingSettingsView> {
  const company = await loadCompany(ctx, companyId);
  const current =
    company.online_booking_settings && typeof company.online_booking_settings === "object" && !Array.isArray(company.online_booking_settings)
      ? (company.online_booking_settings as Record<string, unknown>)
      : {};
  const next = { ...current, ...input };
  const merged = { ...parseOnlineBookingSettings(current), ...input };
  if (merged.endHour <= merged.startHour) throw new ValidationError("The last booking time has to be after the first.");
  if (merged.depositMode !== "none" && !(company.stripe_connected_account_id && company.stripe_charges_enabled)) {
    throw new ValidationError("Connect Stripe under Settings → Payments before taking deposits.");
  }
  const { error } = await ctx.supabase
    .from("companies")
    .update({ online_booking_settings: toJson(next) })
    .eq("organization_id", ctx.organizationId)
    .eq("id", companyId);
  if (error) throw error;
  return getOnlineBookingSettings(ctx, companyId);
}
