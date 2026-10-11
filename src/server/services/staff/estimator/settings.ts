/**
 * The estimator's settings: companies.ai_settings.estimator, read with defaults (the one reader).
 *
 *   enabled      — the AI may draft estimates for work the price list can't price. Default ON for
 *                  CrankLeads orgs, OFF for house orgs (A1 etc.) unless the owner turns it on.
 *   follow_ups   — text front-desk quotes until they're booked. Same default as `enabled`, and
 *                  only runs while the estimator is enabled.
 *   cadence_days — days after the quote was sent for each nudge (1–3 nudges, ascending, 1–30).
 *                  Default [2, 5, 10]; the last one offers a call or the booking link.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const ESTIMATOR_SETTINGS_KEY = "estimator";
export const DEFAULT_CADENCE_DAYS: readonly number[] = [2, 5, 10];
export const MAX_NUDGES = 3;

export interface EstimatorSettings {
  enabled: boolean;
  followUps: boolean;
  cadenceDays: number[];
  /** True when `enabled` came from the default rather than an explicit owner choice. */
  enabledIsDefault: boolean;
}

export interface EstimatorSettingsPatch {
  enabled?: boolean;
  followUps?: boolean;
  cadenceDays?: number[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A valid cadence (1–3 whole days, strictly ascending, 1–30), else null. PURE. */
export function normalizeCadence(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NUDGES) return null;
  const days = value.map((v) => (typeof v === "number" && Number.isInteger(v) ? v : NaN));
  if (days.some((d) => !Number.isFinite(d) || d < 1 || d > 30)) return null;
  for (let i = 1; i < days.length; i++) if (days[i] <= days[i - 1]) return null;
  return days;
}

/** PURE: companies.ai_settings (any shape) → the estimator section with defaults applied. */
export function readEstimatorSettings(aiSettings: unknown, org: { crankleads: boolean }): EstimatorSettings {
  const section = asRecord(asRecord(aiSettings)[ESTIMATOR_SETTINGS_KEY]);
  const explicit = typeof section.enabled === "boolean" ? section.enabled : null;
  const followUps = typeof section.follow_ups === "boolean" ? section.follow_ups : org.crankleads;
  return {
    enabled: explicit ?? org.crankleads,
    followUps,
    cadenceDays: normalizeCadence(section.cadence_days) ?? [...DEFAULT_CADENCE_DAYS],
    enabledIsDefault: explicit === null,
  };
}

/** Follow-ups run only while the estimator itself is on. PURE. */
export function followUpsActive(settings: EstimatorSettings): boolean {
  return settings.enabled && settings.followUps;
}

/** Merge a patch into ai_settings.estimator only (other sections untouched). PURE. */
export function mergeEstimatorSettings(aiSettings: unknown, patch: EstimatorSettingsPatch): Record<string, unknown> {
  const all = { ...asRecord(aiSettings) };
  const section = { ...asRecord(all[ESTIMATOR_SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (typeof patch.followUps === "boolean") section.follow_ups = patch.followUps;
  if (patch.cadenceDays !== undefined) {
    const cadence = normalizeCadence(patch.cadenceDays);
    if (cadence) section.cadence_days = cadence;
  }
  all[ESTIMATOR_SETTINGS_KEY] = section;
  return all;
}

export interface EstimatorCompanySettings extends EstimatorSettings {
  organizationId: string;
  companyId: string;
  crankleads: boolean;
}

/** Load one company's estimator settings (service role). Null → no such company. */
export async function loadEstimatorSettings(admin: AdminClient, companyId: string): Promise<EstimatorCompanySettings | null> {
  const db = admin as Db;
  const { data: company, error } = await db.from("companies").select("id, organization_id, ai_settings").eq("id", companyId).maybeSingle();
  if (error) throw error;
  const row = company as { id: string; organization_id: string; ai_settings: unknown } | null;
  if (!row) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", row.organization_id).maybeSingle();
  const crankleads = (org as { platform_brand: string | null } | null)?.platform_brand === "crankleads";
  return { ...readEstimatorSettings(row.ai_settings, { crankleads }), organizationId: row.organization_id, companyId: row.id, crankleads };
}
