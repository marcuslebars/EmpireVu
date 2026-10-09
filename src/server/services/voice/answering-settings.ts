/**
 * Call answering settings — companies.ai_settings.call_answering (docs/front-desk-ai.md →
 * "## Phone answering"). The ONE typed reader for that section, with the defaults:
 *
 *   mode              "ai" (CrankLeads orgs) | "voicemail" (everyone else, unless they opt in)
 *   included_minutes  monthly AI-answering minutes for Catch / Close (default 100). Front Desk
 *                     uses its plan allowance instead (marina_reception, 500 — billing/config.ts).
 *
 * Pure: no I/O. The settings route merges ONLY this section (mergeCallAnsweringSettings).
 */

export const CALL_ANSWERING_MODES = ["ai", "voicemail"] as const;
export type CallAnsweringMode = (typeof CALL_ANSWERING_MODES)[number];

export const DEFAULT_INCLUDED_MINUTES = 100;
export const MAX_INCLUDED_MINUTES = 10_000;

export interface CallAnsweringSettings {
  mode: CallAnsweringMode;
  /** Monthly allowance for message-taking answering (Catch / Close). */
  includedMinutes: number;
  /** True when the owner (or an operator) chose the mode — false means it's the default. */
  modeExplicit: boolean;
}

export interface CallAnsweringSettingsContext {
  /** organizations.platform_brand === 'crankleads'. House / EmpireVu orgs default to voicemail. */
  crankleads: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isCallAnsweringMode(value: unknown): value is CallAnsweringMode {
  return typeof value === "string" && (CALL_ANSWERING_MODES as readonly string[]).includes(value);
}

function minutes(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(MAX_INCLUDED_MINUTES, Math.round(n));
}

/** Read companies.ai_settings → the call-answering section with defaults applied. */
export function readCallAnsweringSettings(aiSettings: unknown, context: CallAnsweringSettingsContext): CallAnsweringSettings {
  const section = record(record(aiSettings).call_answering);
  const explicit = isCallAnsweringMode(section.mode) ? section.mode : null;
  return {
    mode: explicit ?? (context.crankleads ? "ai" : "voicemail"),
    includedMinutes: minutes(section.included_minutes) ?? DEFAULT_INCLUDED_MINUTES,
    modeExplicit: explicit !== null,
  };
}

export interface CallAnsweringPatch {
  mode?: CallAnsweringMode;
  included_minutes?: number;
}

/**
 * The new ai_settings object with ONLY `call_answering` changed (other sections — sms_agent,
 * weekly_report — are carried over untouched). Pure.
 */
export function mergeCallAnsweringSettings(aiSettings: unknown, patch: CallAnsweringPatch): Record<string, unknown> {
  const current = record(aiSettings);
  const section = { ...record(current.call_answering) };
  if (patch.mode !== undefined) section.mode = patch.mode;
  if (patch.included_minutes !== undefined) {
    const value = minutes(patch.included_minutes);
    if (value !== null) section.included_minutes = value;
  }
  return { ...current, call_answering: section };
}
