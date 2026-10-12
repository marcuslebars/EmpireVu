/**
 * Keep your number settings: companies.ai_settings.porting, read with defaults (docs/ai-staff.md →
 * "Keep your number"). One typed reader; the route merges owner changes into this key only.
 *
 *   porting = {
 *     enabled,                       // the owner can start a port (Settings, "keep my number")
 *     ring: {
 *       enabled,                     // calls to the ported line ring the owner's cell first
 *       seconds: 20,                 // 10–40, then the missed-call / AI answering path
 *       crew: false,                 // also ring team members' cells (organization_memberships.phone_e164)
 *       screen: true,                // "press 1 to take it", so a cell's own voicemail never swallows the call
 *     }
 *   }
 *
 * `enabled` defaults ON for CrankLeads orgs and OFF for house orgs (A1 etc.). The ring settings
 * only ever matter for a company with a ported business line, so they default on everywhere.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";

export interface RingSettings {
  enabled: boolean;
  seconds: number;
  crew: boolean;
  screen: boolean;
}

export interface PortingSettings {
  enabled: boolean;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  ring: RingSettings;
}

export const DEFAULT_RING_SECONDS = 20;
export const MIN_RING_SECONDS = 10;
export const MAX_RING_SECONDS = 40;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function clampRingSeconds(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_RING_SECONDS;
  return Math.min(MAX_RING_SECONDS, Math.max(MIN_RING_SECONDS, n));
}

export function readPortingSettings(aiSettings: unknown, ctx: { crankleads: boolean }): PortingSettings {
  const section = asRecord(asRecord(aiSettings).porting);
  const ring = asRecord(section.ring);
  return {
    enabled: bool(section.enabled, ctx.crankleads),
    enabledIsDefault: typeof section.enabled !== "boolean",
    defaultEnabled: ctx.crankleads,
    ring: {
      enabled: bool(ring.enabled, true),
      seconds: clampRingSeconds(ring.seconds),
      crew: bool(ring.crew, false),
      screen: bool(ring.screen, true),
    },
  };
}

export interface PortingSettingsPatch {
  enabled?: boolean;
  ring?: Partial<RingSettings>;
}

/** The whole ai_settings with ONLY `porting` changed (for updateAiSettings). */
export function mergePortingSettings(aiSettings: unknown, patch: PortingSettingsPatch): Record<string, unknown> {
  const all = { ...asRecord(aiSettings) };
  const section = { ...asRecord(all.porting) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (patch.ring) {
    const ring = { ...asRecord(section.ring) };
    if (typeof patch.ring.enabled === "boolean") ring.enabled = patch.ring.enabled;
    if (patch.ring.seconds !== undefined) ring.seconds = clampRingSeconds(patch.ring.seconds);
    if (typeof patch.ring.crew === "boolean") ring.crew = patch.ring.crew;
    if (typeof patch.ring.screen === "boolean") ring.screen = patch.ring.screen;
    section.ring = ring;
  }
  all.porting = section;
  return all;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface PortingCompany {
  organizationId: string;
  companyId: string;
  name: string;
  timeZone: string;
  ownerPhone: string | null;
  ownerPhoneVerified: boolean;
  businessLine: string | null;
  businessPhoneKind: string | null;
  businessPhoneCarrier: string | null;
  platformBrand: string | null;
  settings: PortingSettings;
  aiSettings: unknown;
}

/** The company + its porting settings, or null when it isn't this org's. */
export async function loadPortingCompany(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<PortingCompany | null> {
  const db = admin as Db;
  const { data: company } = await db
    .from("companies")
    .select("id, organization_id, name, timezone, owner_phone_e164, owner_phone_verified_at, brand_reply_phone, business_phone_kind, business_phone_carrier, ai_settings")
    .eq("organization_id", scope.organizationId)
    .eq("id", scope.companyId)
    .maybeSingle();
  const c = company as {
    id: string;
    name: string | null;
    timezone: string | null;
    owner_phone_e164: string | null;
    owner_phone_verified_at: string | null;
    brand_reply_phone: string | null;
    business_phone_kind: string | null;
    business_phone_carrier: string | null;
    ai_settings: unknown;
  } | null;
  if (!c) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
  const platformBrand = (org as { platform_brand: string | null } | null)?.platform_brand ?? null;
  return {
    organizationId: scope.organizationId,
    companyId: scope.companyId,
    name: c.name?.trim() || "your business",
    timeZone: c.timezone || "America/Toronto",
    ownerPhone: c.owner_phone_e164,
    ownerPhoneVerified: Boolean(c.owner_phone_e164 && c.owner_phone_verified_at),
    businessLine: c.brand_reply_phone,
    businessPhoneKind: c.business_phone_kind,
    businessPhoneCarrier: c.business_phone_carrier,
    platformBrand,
    settings: readPortingSettings(c.ai_settings, { crankleads: platformBrand === "crankleads" }),
    aiSettings: c.ai_settings,
  };
}

/** Is "keep your number" on for the company (its owner tools + prompt notes)? Never throws. */
export async function portingActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    return (await loadPortingCompany(admin, scope))?.settings.enabled ?? false;
  } catch {
    return false;
  }
}
