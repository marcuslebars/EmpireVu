/**
 * The SMS agent's settings: companies.ai_settings.sms_agent, read with defaults.
 *
 *   enabled   — default ON for CrankLeads orgs (organizations.platform_brand = 'crankleads'),
 *               OFF for every other (house) org unless the owner turns it on.
 *   autonomy  — "standard" (default): answers from facts, quotes from the price list, books open
 *               slots; asks the owner for anything else.
 *               "ask_first": every customer-facing answer beyond gathering details needs the
 *               owner's OK. "off": the AI doesn't reply (same as disabled).
 *
 * Caps (env): SMS_AGENT_MAX_REPLIES_PER_CONVERSATION_DAY (25) and SMS_AGENT_MAX_REPLIES_PER_COMPANY_DAY
 * (300) — past either, the conversation is handed to the owner.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";

export type SmsAgentAutonomy = "standard" | "ask_first" | "off";
export const SMS_AGENT_AUTONOMY: readonly SmsAgentAutonomy[] = ["standard", "ask_first", "off"];

export interface SmsAgentSettings {
  enabled: boolean;
  autonomy: SmsAgentAutonomy;
  /** True when `enabled` came from the default rather than an explicit owner choice. */
  enabledIsDefault: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** PURE: companies.ai_settings (any shape) → the SMS agent section with defaults applied. */
export function readSmsAgentSettings(aiSettings: unknown, org: { crankleads: boolean }): SmsAgentSettings {
  const section = asRecord(asRecord(aiSettings).sms_agent);
  const explicit = typeof section.enabled === "boolean" ? section.enabled : null;
  const autonomy = SMS_AGENT_AUTONOMY.includes(section.autonomy as SmsAgentAutonomy)
    ? (section.autonomy as SmsAgentAutonomy)
    : "standard";
  return { enabled: explicit ?? org.crankleads, autonomy, enabledIsDefault: explicit === null };
}

/** The AI replies only when it's on and autonomy isn't "off". */
export function smsAgentActive(settings: SmsAgentSettings): boolean {
  return settings.enabled && settings.autonomy !== "off";
}

export interface SmsAgentCompanySettings extends SmsAgentSettings {
  organizationId: string;
  companyId: string;
  crankleads: boolean;
}

/** Load a company's SMS agent settings (service role or the caller's RLS client). Null → no such company. */
export async function loadSmsAgentSettings(
  db: AdminClient,
  companyId: string,
): Promise<SmsAgentCompanySettings | null> {
  const { data: company, error } = await db
    .from("companies")
    .select("id, organization_id, ai_settings")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  const row = company as { id: string; organization_id: string; ai_settings: unknown } | null;
  if (!row) return null;
  const { data: org } = await db
    .from("organizations")
    .select("platform_brand")
    .eq("id", row.organization_id)
    .maybeSingle();
  const crankleads = (org as { platform_brand: string | null } | null)?.platform_brand === "crankleads";
  return { ...readSmsAgentSettings(row.ai_settings, { crankleads }), organizationId: row.organization_id, companyId: row.id, crankleads };
}

/** Merge a patch into ai_settings.sms_agent only (other sections untouched). PURE. */
export function mergeSmsAgentSettings(
  aiSettings: unknown,
  patch: { enabled?: boolean; autonomy?: SmsAgentAutonomy },
): Record<string, unknown> {
  const all = { ...asRecord(aiSettings) };
  const section = { ...asRecord(all.sms_agent) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (patch.autonomy && SMS_AGENT_AUTONOMY.includes(patch.autonomy)) section.autonomy = patch.autonomy;
  all.sms_agent = section;
  return all;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface SmsAgentLimits {
  perConversationPerDay: number;
  perCompanyPerDay: number;
  /** Max model calls (tool round-trips) in one turn. */
  maxIterations: number;
  /** Whole-turn budget. */
  turnTimeoutMs: number;
  /** Wait this long after taking the turn so rapid-fire texts are answered together. */
  coalesceMs: number;
  /** A turn lease older than this is considered abandoned. */
  leaseMs: number;
  /** Owner takeover lasts this long without an explicit "AI back on". */
  takeoverMs: number;
}

export function smsAgentLimits(): SmsAgentLimits {
  return {
    perConversationPerDay: envInt("SMS_AGENT_MAX_REPLIES_PER_CONVERSATION_DAY", 25),
    perCompanyPerDay: envInt("SMS_AGENT_MAX_REPLIES_PER_COMPANY_DAY", 300),
    maxIterations: envInt("SMS_AGENT_MAX_TOOL_ITERATIONS", 6),
    turnTimeoutMs: envInt("SMS_AGENT_TURN_TIMEOUT_MS", 60_000),
    coalesceMs: envInt("SMS_AGENT_COALESCE_MS", 4_000),
    leaseMs: 120_000,
    takeoverMs: 72 * 3_600_000,
  };
}
