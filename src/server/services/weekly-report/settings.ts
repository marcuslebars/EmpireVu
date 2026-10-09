import type { Json } from "@/server/db/database.types";

/**
 * Weekly report settings — the ONE reader of companies.ai_settings.weekly_report
 * (docs/front-desk-ai.md → "Weekly report"). Missing keys = defaults here:
 *   - enabled: ON for CrankLeads orgs (it's the proof of value), OFF for everyone else.
 *   - channels: CrankLeads → ["sms", "email"]; others → ["email"].
 * SMS goes from the platform number and is CrankLeads-only, so a non-CrankLeads org's
 * channels are always filtered down to email.
 */

export const WEEKLY_REPORT_CHANNELS = ["sms", "email"] as const;
export type WeeklyReportChannel = (typeof WEEKLY_REPORT_CHANNELS)[number];

export interface WeeklyReportSettings {
  enabled: boolean;
  channels: WeeklyReportChannel[];
  /** Whether the stored value set `enabled` explicitly (vs the default). */
  explicit: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function defaultWeeklyReportChannels(isCrankleads: boolean): WeeklyReportChannel[] {
  return isCrankleads ? ["sms", "email"] : ["email"];
}

/** companies.ai_settings (whole blob) → typed weekly-report settings with defaults. */
export function parseWeeklyReportSettings(aiSettings: Json | null | undefined, isCrankleads: boolean): WeeklyReportSettings {
  const section = asRecord(asRecord(aiSettings).weekly_report);
  const explicit = typeof section.enabled === "boolean";
  const enabled = explicit ? (section.enabled as boolean) : isCrankleads;
  let channels: WeeklyReportChannel[] = Array.isArray(section.channels)
    ? WEEKLY_REPORT_CHANNELS.filter((channel) => (section.channels as unknown[]).includes(channel))
    : defaultWeeklyReportChannels(isCrankleads);
  if (!isCrankleads) channels = channels.filter((channel) => channel !== "sms");
  if (channels.length === 0) channels = ["email"];
  return { enabled, channels, explicit };
}

export interface WeeklyReportSettingsPatch {
  enabled?: boolean;
  channels?: WeeklyReportChannel[];
}

/**
 * Merge a patch into the whole ai_settings blob, touching ONLY the weekly_report key (other
 * sections — sms_agent, call_answering — are carried over untouched).
 */
export function mergeWeeklyReportSettings(aiSettings: Json | null | undefined, patch: WeeklyReportSettingsPatch): Json {
  const blob = { ...asRecord(aiSettings) };
  const section = { ...asRecord(blob.weekly_report) };
  if (patch.enabled !== undefined) section.enabled = patch.enabled;
  if (patch.channels !== undefined) {
    section.channels = WEEKLY_REPORT_CHANNELS.filter((channel) => patch.channels?.includes(channel));
  }
  blob.weekly_report = section;
  return blob as Json;
}
