/**
 * The Bookkeeper's settings: companies.ai_settings.collections, read with defaults. The ONE typed
 * reader (docs/ai-staff.md → "Bookkeeper").
 *
 *   enabled        master switch. Default ON for CrankLeads orgs, OFF for house orgs (A1…) unless
 *                  the owner turns it on. Off → no texts, no alerts, and the tools say so.
 *   textReminders  overdue invoices get reminder texts with the pay link (default on).
 *   reminderDays   days past due for each text (default 3, 10, 20, 30 — between the email
 *                  reminders' 1, 7, 14). Tone goes gentle → firm along the list.
 *   finalNotice    after the last text, propose a "final reminder" for the owner's OK (default on).
 *   dailyAlert     08:00 owner money alert when something notable happened (default on).
 *
 * PURE apart from loadCollectionsSettings.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";

export const SETTINGS_KEY = "collections";
export const DEFAULT_REMINDER_DAYS = [3, 10, 20, 30];
export const MAX_REMINDER_STEPS = 6;
export const MAX_REMINDER_DAY = 120;

export interface CollectionsSettings {
  enabled: boolean;
  /** `enabled` came from the default (no explicit choice yet). */
  enabledIsDefault: boolean;
  textReminders: boolean;
  reminderDays: number[];
  finalNotice: boolean;
  dailyAlert: boolean;
}

export interface CollectionsPatch {
  enabled?: boolean;
  textReminders?: boolean;
  reminderDays?: number[];
  finalNotice?: boolean;
  dailyAlert?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 1–6 whole days in 1..120, unique, ascending; null when nothing usable. PURE. */
export function normalizeReminderDays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days = [...new Set(value.map((d) => (typeof d === "number" ? Math.round(d) : Number.NaN)).filter((d) => Number.isFinite(d) && d >= 1 && d <= MAX_REMINDER_DAY))].sort((a, b) => a - b);
  return days.length ? days.slice(0, MAX_REMINDER_STEPS) : null;
}

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** companies.ai_settings (any shape) → the Bookkeeper section with defaults. PURE. */
export function readCollectionsSettings(aiSettings: unknown, org: { crankleads: boolean }): CollectionsSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const explicit = typeof s.enabled === "boolean" ? s.enabled : null;
  return {
    enabled: explicit ?? org.crankleads,
    enabledIsDefault: explicit === null,
    textReminders: bool(s.textReminders, true),
    reminderDays: normalizeReminderDays(s.reminderDays) ?? DEFAULT_REMINDER_DAYS,
    finalNotice: bool(s.finalNotice, true),
    dailyAlert: bool(s.dailyAlert, true),
  };
}

/** The new ai_settings with ONLY `collections` changed. PURE. */
export function mergeCollectionsSettings(aiSettings: unknown, patch: CollectionsPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  for (const key of ["enabled", "textReminders", "finalNotice", "dailyAlert"] as const) {
    if (typeof patch[key] === "boolean") section[key] = patch[key];
  }
  if (patch.reminderDays !== undefined) {
    const days = normalizeReminderDays(patch.reminderDays);
    if (days) section.reminderDays = days;
  }
  all[SETTINGS_KEY] = section;
  return all;
}

export interface CompanyCollectionsSettings extends CollectionsSettings {
  organizationId: string;
  companyId: string;
  crankleads: boolean;
}

/** One company's settings (service role). Null → no such company in that org. */
export async function loadCollectionsSettings(admin: AdminClient, organizationId: string, companyId: string): Promise<CompanyCollectionsSettings | null> {
  const db = admin as Db;
  const { data } = await db.from("companies").select("id, organization_id, ai_settings").eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  const crankleads = isCrankleadsOrg(org);
  return { ...readCollectionsSettings((data as { ai_settings: unknown }).ai_settings, { crankleads }), organizationId, companyId, crankleads };
}

/** organizations row → CrankLeads? (platform_brand 'crankleads', like the front desk's readers). PURE. */
export function isCrankleadsOrg(org: unknown): boolean {
  return record(org).platform_brand === "crankleads";
}
