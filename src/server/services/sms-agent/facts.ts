/**
 * The business facts the SMS agent may use — and nothing else. Everything here comes from the
 * company's own records (name, price list, hours, service area, booking setup, policies on file).
 * The prompt tells the model these are the ONLY facts; the reply guard enforces the money part.
 */
import { parseBookingPolicy, type BookingPolicy } from "@/server/services/booking-windows";
import { getBusinessTimezone } from "@/server/services/ai";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { hoursToText } from "@/server/services/onboarding-provision";
import { getPack } from "@/server/services/packs";
import { parseAppliedIndustryPack } from "@/server/services/packs/types";
import { quotePublicBaseUrlFor } from "@/server/services/quotes/config";
import {
  bookableService,
  flatPrice,
  parseOnlineBookingSettings,
  type CatalogService,
  type OnlineBookingSettings,
} from "@/server/services/scheduling/rules";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface PriceListItem {
  key: string;
  label: string;
  description: string | null;
  pricingType: string;
  unitLabel: string | null;
  rateCents: number;
  minimumCents: number;
  /** "$450", "$12 per foot", "From $200", or null when there's no price on file. */
  priceText: string | null;
  /** Needs a measurement (sq ft, feet, km…) to price. */
  needsMeasure: boolean;
  /** Has choices that change the price (tier, size…): [{ key, label, options: [key: label] }]. */
  choices: Array<{ key: string; label: string; required: boolean; options: Array<{ key: string; label: string }> }>;
}

export type BookingMode = "windows" | "hourly" | "none";

export interface BusinessFacts {
  organizationId: string;
  companyId: string;
  businessName: string;
  /** The trade from the industry pack (e.g. "Snow removal & property maintenance"), if one was applied. */
  trade: string | null;
  /** First name of the owner, for "Let me check with Dana". Null → "the owner". */
  ownerFirstName: string | null;
  timeZone: string;
  hoursText: string | null;
  serviceArea: string | null;
  businessAddress: string | null;
  website: string | null;
  businessPhone: string | null;
  priceList: PriceListItem[];
  bookingMode: BookingMode;
  bookingPolicy: BookingPolicy | null;
  onlineBooking: OnlineBookingSettings;
  /** The public booking page, when online booking is on. */
  bookingUrl: string | null;
  cancellationPolicy: string | null;
  quoteTerms: string | null;
  /** Questions a business in this trade usually asks (from the pack) — to gather details, not facts. */
  qualifyingQuestions: string[];
  /** Words that mean "urgent / emergency" in this trade. */
  urgentKeywords: string[];
}

const MEASURE_TYPES = new Set(["per_measure", "tiered_by_measure", "per_measure_banded"]);

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function choicesOf(raw: unknown): PriceListItem["choices"] {
  return asArray(raw)
    .map((g) => g as { key?: unknown; label?: unknown; required?: unknown; options?: unknown })
    .filter((g) => typeof g.key === "string")
    .map((g) => ({
      key: g.key as string,
      label: typeof g.label === "string" ? g.label : (g.key as string),
      required: g.required === true,
      options: asArray(g.options)
        .map((o) => o as { key?: unknown; label?: unknown })
        .filter((o) => typeof o.key === "string")
        .map((o) => ({ key: o.key as string, label: typeof o.label === "string" ? o.label : (o.key as string) })),
    }));
}

/** PURE: a catalog row → what the agent may say about it. */
export function priceListItem(row: CatalogService & { service_key: string; modifier_groups?: unknown }, settings: OnlineBookingSettings): PriceListItem {
  const view = bookableService(row, settings, false);
  return {
    key: row.service_key,
    label: row.label,
    description: row.description,
    pricingType: row.pricing_type,
    unitLabel: row.unit_label,
    rateCents: Number(row.rate_cents ?? 0),
    minimumCents: Number(row.minimum_cents ?? 0),
    priceText: view.priceLabel,
    needsMeasure: MEASURE_TYPES.has(row.pricing_type),
    choices: choicesOf(row.modifier_groups),
  };
}

/** Every dollar amount the price list itself states (in cents) — the reply guard allows these. */
export function priceListAmounts(items: PriceListItem[]): number[] {
  const out = new Set<number>();
  for (const item of items) {
    if (item.rateCents > 0) out.add(item.rateCents);
    if (item.minimumCents > 0) out.add(item.minimumCents);
    const flat = flatPrice({ pricing_type: item.pricingType, rate_cents: item.rateCents, minimum_cents: item.minimumCents } as CatalogService);
    if (flat) out.add(flat);
  }
  return [...out];
}

async function ownerFirstName(admin: Db, organizationId: string): Promise<string | null> {
  try {
    const { data } = await admin
      .from("organization_memberships")
      .select("profile_id, role")
      .eq("organization_id", organizationId)
      .eq("role", "owner")
      .limit(1);
    const profileId = ((data ?? []) as Array<{ profile_id: string }>)[0]?.profile_id;
    if (!profileId) return null;
    const { data: profile } = await admin.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
    const first = (profile as { full_name: string | null } | null)?.full_name?.trim().split(/\s+/)[0] ?? "";
    return /^[A-Za-zÀ-ÿ'-]{2,30}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

/** Load the facts for one company (service role). Throws if the company is missing. */
export async function loadBusinessFacts(admin: AdminClient, companyId: string): Promise<BusinessFacts> {
  const db = admin as Db;
  const { data: company, error } = await db.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!company) throw new Error(`Company ${companyId} not found.`);
  const c = company as Record<string, unknown> & { id: string; organization_id: string; name: string };

  const { data: items, error: itemsError } = await db
    .from("service_catalog_items")
    .select("*")
    .eq("organization_id", c.organization_id)
    .eq("company_id", c.id)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .limit(60);
  if (itemsError) throw itemsError;

  const onlineBooking = parseOnlineBookingSettings(c.online_booking_settings);
  const bookingPolicy = parseBookingPolicy(c.booking_policy ?? null);
  const bookingMode: BookingMode = bookingPolicy ? "windows" : onlineBooking.enabled ? "hourly" : "none";
  const applied = parseAppliedIndustryPack(c.industry_pack);
  const pack = applied ? getPack(applied.id) : null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  return {
    organizationId: c.organization_id,
    companyId: c.id,
    businessName: text(c.brand_from_name) ?? c.name,
    trade: pack?.name ?? null,
    ownerFirstName: await ownerFirstName(db, c.organization_id),
    timeZone: text(c.timezone) ?? getBusinessTimezone(),
    hoursText: hoursToText((c.hours ?? null) as never),
    serviceArea: text(c.service_area),
    businessAddress: text(c.business_address),
    website: text(c.brand_website_url) ?? text(c.website),
    businessPhone: text(c.brand_reply_phone),
    priceList: ((items ?? []) as Array<CatalogService & { service_key: string; modifier_groups?: unknown }>).map((row) =>
      priceListItem(row, onlineBooking),
    ),
    bookingMode,
    bookingPolicy,
    onlineBooking,
    bookingUrl: onlineBooking.enabled ? `${quotePublicBaseUrlFor({ quote_public_base_url: c.quote_public_base_url })}/book/${c.id}` : null,
    cancellationPolicy: text(c.cancellation_policy_text),
    quoteTerms: text(c.quote_terms_text),
    qualifyingQuestions: pack?.receptionist.qualifyingQuestions ?? [],
    urgentKeywords: pack?.receptionist.urgentKeywords ?? [],
  };
}
