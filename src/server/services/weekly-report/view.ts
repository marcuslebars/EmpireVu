import type { Json } from "@/server/db/database.types";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { companyTimeZone } from "@/server/services/monthly-scorecard/scorecard";
import { scorecardPlatformBrandName } from "@/server/services/monthly-scorecard/platform-brand";
import { shiftWeekKey, weekKeyInTimeZone, weekLabel, weekRangeForKey } from "@/server/services/monthly-scorecard/weeks";
import { loadOrganizationBrand } from "@/server/services/platform-brand";
import {
  computeWeekForCompany,
  HOURS_SAVED_ASSUMPTIONS,
  hoursSavedAssumptionsText,
  type WeeklyReportMetrics,
} from "@/server/services/weekly-report/metrics";
import {
  mergeWeeklyReportSettings,
  parseWeeklyReportSettings,
  type WeeklyReportSettings,
  type WeeklyReportSettingsPatch,
} from "@/server/services/weekly-report/settings";

/**
 * In-app weekly report (dashboard "This week" card + /reports/weekly). Reads on the caller's
 * RLS client, every query filtered by organization_id + company_id. A week that was already
 * sent shows the numbers we sent (weekly_report_sends.metrics); any other week is computed
 * live by the same code the send uses.
 */

export interface WeeklyReportWeek {
  weekStart: string;
  label: string;
  /** The current week, still in progress. */
  partial: boolean;
  metrics: WeeklyReportMetrics;
  send: { status: string; sentAt: string | null; channels: string[] } | null;
}

export interface WeeklyReportView {
  companyId: string;
  companyName: string;
  timeZone: string;
  isCrankleads: boolean;
  brandName: string;
  settings: { enabled: boolean; channels: WeeklyReportSettings["channels"] };
  ownerPhoneOnFile: boolean;
  assumptions: { text: string; values: typeof HOURS_SAVED_ASSUMPTIONS };
  /** Newest first: [this week so far?, last week, the week before, …]. */
  weeks: WeeklyReportWeek[];
}

const MAX_WEEKS = 12;
const LIVE_CONCURRENCY = 3;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function storedMetrics(raw: Json | null | undefined): WeeklyReportMetrics | null {
  const record = asRecord(raw);
  if (record.version !== 1 || typeof record.weekStart !== "string" || !record.hoursSaved) return null;
  const { delivery: _delivery, skipped: _skipped, ...metrics } = record;
  return metrics as unknown as WeeklyReportMetrics;
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function getWeeklyReportView(
  context: TenantServiceContext,
  companyId: string,
  options: { weeks?: number; includeCurrent?: boolean; nowMs?: number } = {},
): Promise<WeeklyReportView> {
  await assertCompanyInOrganization(context, companyId);
  const nowMs = options.nowMs ?? Date.now();
  const count = Math.max(1, Math.min(MAX_WEEKS, Math.floor(options.weeks ?? 8)));

  const { data: companyRow, error } = await context.supabase
    .from("companies")
    .select("id, name, timezone, ai_settings, owner_phone_e164")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  const company = companyRow as { id: string; name: string; timezone: string | null; ai_settings: Json; owner_phone_e164: string | null };
  const brand = await loadOrganizationBrand(context.supabase, context.organizationId);
  const isCrankleads = brand.key === "crankleads";
  const settings = parseWeeklyReportSettings(company.ai_settings, isCrankleads);
  const timeZone = companyTimeZone(company);

  const current = weekKeyInTimeZone(timeZone, nowMs);
  const keys: Array<{ key: string; partial: boolean }> = [];
  if (options.includeCurrent) keys.push({ key: current, partial: true });
  for (let i = 1; i <= count; i += 1) keys.push({ key: shiftWeekKey(current, -i), partial: false });

  const { data: sendRows } = await context.supabase
    .from("weekly_report_sends")
    .select("week_start, status, sent_at, channels, metrics")
    .eq("organization_id", context.organizationId)
    .eq("company_id", companyId)
    .gte("week_start", keys[keys.length - 1].key)
    .limit(50);
  const sends = new Map(
    ((sendRows ?? []) as Array<{ week_start: string; status: string; sent_at: string | null; channels: string[] | null; metrics: Json }>).map(
      (row) => [row.week_start, row],
    ),
  );

  const weeks = await mapLimit(keys, LIVE_CONCURRENCY, async ({ key, partial }): Promise<WeeklyReportWeek> => {
    const send = sends.get(key);
    const stored = !partial && send?.status === "sent" ? storedMetrics(send.metrics) : null;
    const metrics = stored ?? (await computeWeekForCompany(context, companyId, key, weekRangeForKey(timeZone, key), timeZone));
    return {
      weekStart: key,
      label: weekLabel(key),
      partial,
      metrics,
      send: send ? { status: send.status, sentAt: send.sent_at, channels: send.channels ?? [] } : null,
    };
  });

  return {
    companyId,
    companyName: company.name,
    timeZone,
    isCrankleads,
    brandName: scorecardPlatformBrandName(brand),
    settings: { enabled: settings.enabled, channels: settings.channels },
    ownerPhoneOnFile: Boolean(company.owner_phone_e164?.trim()),
    assumptions: { text: hoursSavedAssumptionsText(), values: HOURS_SAVED_ASSUMPTIONS },
    weeks,
  };
}

export interface WeeklyReportSettingsView {
  enabled: boolean;
  channels: WeeklyReportSettings["channels"];
  isCrankleads: boolean;
  brandName: string;
  ownerPhoneOnFile: boolean;
  ownerEmailOnFile: boolean;
}

/** Settings section read (RLS client). */
export async function getWeeklyReportSettingsView(context: TenantServiceContext, companyId: string): Promise<WeeklyReportSettingsView> {
  const { data, error } = await context.supabase
    .from("companies")
    .select("ai_settings, owner_phone_e164, owner_email")
    .eq("organization_id", context.organizationId)
    .eq("id", companyId)
    .single();
  if (error) throw error;
  const row = data as { ai_settings: Json; owner_phone_e164: string | null; owner_email: string | null };
  const brand = await loadOrganizationBrand(context.supabase, context.organizationId);
  const isCrankleads = brand.key === "crankleads";
  const settings = parseWeeklyReportSettings(row.ai_settings, isCrankleads);
  return {
    enabled: settings.enabled,
    channels: settings.channels,
    isCrankleads,
    brandName: scorecardPlatformBrandName(brand),
    ownerPhoneOnFile: Boolean(row.owner_phone_e164?.trim()),
    ownerEmailOnFile: Boolean(row.owner_email?.trim()),
  };
}

// ── Settings write (service role; caller checked org admin + company-in-org) ──────

type Admin = ReturnType<typeof createSupabaseAdminClient>;

/**
 * Merge `patch` into companies.ai_settings.weekly_report ONLY (the other sections are owned
 * by other modules and carried over). Optimistic: the write is conditional on the row's
 * updated_at being unchanged, retried a few times, so a concurrent write to another section
 * is never clobbered.
 */
export async function updateWeeklyReportSettings(
  admin: Admin,
  organizationId: string,
  companyId: string,
  patch: WeeklyReportSettingsPatch,
  isCrankleads: boolean,
): Promise<WeeklyReportSettings> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, error } = await admin
      .from("companies")
      .select("ai_settings, updated_at")
      .eq("organization_id", organizationId)
      .eq("id", companyId)
      .single();
    if (error) throw error;
    const row = data as { ai_settings: Json; updated_at: string };
    const next = mergeWeeklyReportSettings(row.ai_settings, patch);
    const { data: written, error: writeError } = await admin
      .from("companies")
      .update({ ai_settings: next, updated_at: new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString() })
      .eq("organization_id", organizationId)
      .eq("id", companyId)
      .eq("updated_at", row.updated_at)
      .select("ai_settings");
    if (writeError) throw writeError;
    if ((written ?? []).length > 0) return parseWeeklyReportSettings(next, isCrankleads);
  }
  throw new Error("Could not save the weekly report settings (the company was being updated) — try again.");
}
