/**
 * The Email inbox settings: companies.ai_settings.email_clerk, read with defaults. The ONE typed
 * reader (docs/ai-staff.md → "Email inbox").
 *
 *   email_clerk = {
 *     enabled,              // CrankLeads on (inert until mail arrives), house orgs (A1 …) off unless switched on
 *     draft_replies: true,  // customer emails get a drafted reply for the owner's Y/N
 *     digest: true,         // one daily text summing up the rest
 *     digest_time: "16:00", // 12:00–19:00 local
 *     any_on                // marker for the sweeps' server-side filter (house orgs that opted in)
 *   }
 *
 * The server side: INBOUND_EMAIL_DOMAIN + RESEND_WEBHOOK_SECRET. Without either the role is inert
 * (no inbox address, no sweeps, no tools) and Settings says it isn't set up on this server yet.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "./db-types";
import { envWithFallback, noteLegacyUsage } from "@/server/services/rebrand/legacy-usage";

export const SETTINGS_KEY = "email_clerk";
export const DEFAULT_TIMEZONE = "America/Toronto";
export const DEFAULT_DIGEST_TIME = "16:00";

export interface EmailClerkSettings {
  enabled: boolean;
  draftReplies: boolean;
  digest: boolean;
  digestTime: string;
  defaultEnabled: boolean;
  enabledIsDefault: boolean;
}

export interface EmailClerkSettingsPatch {
  enabled?: boolean;
  draftReplies?: boolean;
  digest?: boolean;
  digestTime?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** "HH:MM" between 12:00 and 19:30, on the half hour. PURE. */
export function validDigestTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 12 && h <= 19 && (min === 0 || min === 30);
}

/** companies.ai_settings (any shape) → the Email inbox section with defaults. PURE. */
export function readEmailClerkSettings(aiSettings: unknown, org: { crankleads: boolean }): EmailClerkSettings {
  const s = record(record(aiSettings)[SETTINGS_KEY]);
  const enabled = typeof s.enabled === "boolean" ? s.enabled : null;
  return {
    enabled: enabled ?? org.crankleads,
    draftReplies: typeof s.draft_replies === "boolean" ? s.draft_replies : true,
    digest: typeof s.digest === "boolean" ? s.digest : true,
    digestTime: validDigestTime(s.digest_time) ? s.digest_time : DEFAULT_DIGEST_TIME,
    defaultEnabled: org.crankleads,
    enabledIsDefault: enabled === null,
  };
}

/** The new ai_settings with ONLY `email_clerk` changed. PURE. */
export function mergeEmailClerkSettings(aiSettings: unknown, patch: EmailClerkSettingsPatch): Record<string, unknown> {
  const all = { ...record(aiSettings) };
  const section = { ...record(all[SETTINGS_KEY]) };
  if (typeof patch.enabled === "boolean") section.enabled = patch.enabled;
  if (typeof patch.draftReplies === "boolean") section.draft_replies = patch.draftReplies;
  if (typeof patch.digest === "boolean") section.digest = patch.digest;
  if (validDigestTime(patch.digestTime)) section.digest_time = patch.digestTime;
  section.any_on = section.enabled === true;
  all[SETTINGS_KEY] = section;
  return all;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Every inbound domain this server receives for, primary first: INBOUND_EMAIL_DOMAINS (comma
 * list; the first one is used for NEW addresses), falling back to the single INBOUND_EMAIL_DOMAIN.
 * Matching an inbound recipient accepts any of them, so moving the primary domain (e.g.
 * in.crankleads.com → in.everdoer.com) never orphans an address already handed out. Invalid
 * entries are skipped. PURE apart from the env read.
 */
export function inboundDomains(env: Record<string, string | undefined> = process.env): string[] {
  // Rebrand shim (remove in PR 8 once legacy_usage shows no env/INBOUND_EMAIL_DOMAIN for 30 days)
  const raw = envWithFallback("INBOUND_EMAIL_DOMAINS", ["INBOUND_EMAIL_DOMAIN"], env) ?? "";
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const domain = part.trim().toLowerCase().replace(/^@/, "");
    if (DOMAIN_RE.test(domain) && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/** The primary inbound domain (new addresses are made on it), or null when not configured. */
export function inboundDomain(env: Record<string, string | undefined> = process.env): string | null {
  return inboundDomains(env)[0] ?? null;
}

/** The inbound domain `address` is on, if it is one of ours. PURE. */
export function ourInboundDomainOf(address: string | null | undefined, domains: readonly string[]): string | null {
  const a = (address ?? "").trim().toLowerCase();
  return domains.find((d) => a.endsWith(`@${d}`)) ?? null;
}

/** Count a match on an old-brand inbound domain (empirevu / crankleads in the name). */
export function noteInboundDomainUse(domain: string | null): void {
  if (domain && /empirevu|crankleads/.test(domain)) {
    // Rebrand shim (remove in PR 8 once legacy_usage shows no inbound_email_domain/<domain> for 30 days)
    noteLegacyUsage("inbound_email_domain", domain, null);
  }
}

export function inboundConfigured(): boolean {
  return Boolean(inboundDomain() && process.env.RESEND_WEBHOOK_SECRET?.trim());
}

export const NOT_SET_UP = "Email inbox isn't set up on this server yet.";

export function zoneOf(timeZone: string | null | undefined): string {
  const tz = timeZone?.trim();
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** One company as the Email inbox sees it. */
export interface EmailClerkCompany {
  organizationId: string;
  companyId: string;
  name: string;
  slug: string | null;
  timeZone: string;
  crankleads: boolean;
  platformBrand: string | null;
  /** Verified owner cell (texts go here), else null. */
  ownerPhone: string | null;
  ownerEmail: string | null;
  active: boolean;
  settings: EmailClerkSettings;
}

const COMPANY_COLUMNS = "id, organization_id, name, slug, brand_from_name, timezone, ai_settings, owner_phone_e164, owner_phone_verified_at, owner_email, stage";

interface CompanyRow {
  id: string;
  organization_id: string;
  name: string;
  slug?: string | null;
  brand_from_name?: string | null;
  timezone: string | null;
  ai_settings: unknown;
  owner_phone_e164: string | null;
  owner_phone_verified_at: string | null;
  owner_email?: string | null;
  stage?: string | null;
}

function toCompany(row: CompanyRow, platformBrand: string | null): EmailClerkCompany {
  const crankleads = platformBrand === "crankleads";
  return {
    organizationId: row.organization_id,
    companyId: row.id,
    name: (row.brand_from_name?.trim() || row.name || "").trim() || "the business",
    slug: typeof row.slug === "string" && row.slug.trim() ? row.slug.trim() : null,
    timeZone: zoneOf(row.timezone),
    crankleads,
    platformBrand,
    ownerPhone: row.owner_phone_verified_at && row.owner_phone_e164?.trim() ? row.owner_phone_e164.trim() : null,
    ownerEmail: row.owner_email?.trim() || null,
    active: !row.stage || !["archived", "paused", "cancelled"].includes(row.stage),
    settings: readEmailClerkSettings(row.ai_settings, { crankleads }),
  };
}

/** One company (service role), scoped by org. Null → no such company in that org. */
export async function loadEmailClerkCompany(admin: AdminClient, organizationId: string, companyId: string): Promise<EmailClerkCompany | null> {
  const db = admin as Db;
  const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).eq("organization_id", organizationId).eq("id", companyId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", organizationId).maybeSingle();
  return toCompany(data as CompanyRow, (record(org).platform_brand as string | null) ?? null);
}

/** Feature on for this company (ignores the server config). */
export function emailClerkOn(company: EmailClerkCompany | null): company is EmailClerkCompany {
  return Boolean(company && company.active && company.settings.enabled);
}

/**
 * Is the Email inbox on for this company? (Gates its owner tools, prompt notes and briefing
 * items.) Needs the server side set up too. Never throws.
 */
export async function emailClerkActiveFor(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<boolean> {
  try {
    if (!inboundConfigured()) return false;
    return emailClerkOn(await loadEmailClerkCompany(admin, scope.organizationId, scope.companyId));
  } catch {
    return false;
  }
}

const PAGE = 1000;

async function readAll<T>(make: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Companies that have an inbox and the feature on. Only companies with an `email_inboxes` row can
 * receive mail at all, and inboxes are only made where the feature is on, so house orgs (A1) never
 * enter a sweep unless they switched it on (and set up forwarding).
 */
export async function loadEmailClerkCompanies(admin: AdminClient): Promise<EmailClerkCompany[]> {
  const db = admin as Db;
  const inboxes = await readAll<{ organization_id: string; company_id: string }>((from, to) =>
    db.from("email_inboxes").select("organization_id, company_id").order("company_id", { ascending: true }).range(from, to),
  );
  if (inboxes.length === 0) return [];
  const orgIds = [...new Set(inboxes.map((i) => i.organization_id))];
  const brands = new Map<string, string | null>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const { data } = await db.from("organizations").select("id, platform_brand").in("id", orgIds.slice(i, i + 200));
    for (const o of (data ?? []) as Array<{ id: string; platform_brand: string | null }>) brands.set(o.id, o.platform_brand);
  }
  const companyIds = [...new Set(inboxes.map((i) => i.company_id))];
  const out: EmailClerkCompany[] = [];
  for (let i = 0; i < companyIds.length; i += 200) {
    const { data, error } = await db.from("companies").select(COMPANY_COLUMNS).in("id", companyIds.slice(i, i + 200));
    if (error) throw error;
    for (const r of (data ?? []) as CompanyRow[]) {
      const company = toCompany(r, brands.get(r.organization_id) ?? null);
      if (emailClerkOn(company)) out.push(company);
    }
  }
  return out;
}
