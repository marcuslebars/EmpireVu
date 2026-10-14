/**
 * D7 (Everdoer rebrand): which From a company's email goes out from.
 *
 *   1. `companies.email_from_address`, when set (service role only; no client grant, no UI);
 *   2. the HOUSE org (A1: plan 'internal' or slug LEAD_INTAKE_ORG_SLUG, the same rule as
 *      messaging.ts isHouseOrganization) keeps OUTBOUND_FROM_EMAIL exactly as configured, display
 *      name included, whatever else is set. A1 never moves to @everdoer.com;
 *   3. EVERDOER_DEFAULT_FROM_EMAIL (hello@everdoer.com once the domain is verified in Resend);
 *   4. today's OUTBOUND_FROM_EMAIL || LEAD_FROM_EMAIL.
 * Platform mail (invites, welcome, operator mail, scorecards) has no company: 3, then 4.
 * With EVERDOER_DEFAULT_FROM_EMAIL unset and no column value, every message goes out exactly as
 * before.
 *
 * loadCompanyFromAddress reads the company (and its org) with the SERVICE-ROLE client, keyed by
 * company id, and caches successful reads for a few minutes. A failed read (error, or no row):
 *   • EVERDOER_DEFAULT_FROM_EMAIL unset → today's sender (identical behaviour);
 *   • set → throws CompanySenderUnavailableError: the send fails through the caller's own failure
 *     path rather than guessing (a guess could put A1's customer mail on @everdoer.com).
 * Failures are logged, at most once a minute.
 *
 * Deliberately imports nothing from outbound/email.ts: many tests mock that module with only
 * `sendEmail`.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";

type Admin = ReturnType<typeof createSupabaseAdminClient>;

export interface CompanySenderInfo {
  /** companies.email_from_address, when it is one plain address. */
  own: string | null;
  /** The company belongs to the house org (A1). */
  house: boolean;
}

/** Slug of the house/platform org (A1): same source as lead intake (LEAD_INTAKE_ORG_SLUG). */
export function houseOrgSlug(env: NodeJS.ProcessEnv = process.env): string {
  return env.LEAD_INTAKE_ORG_SLUG ?? "a1-group";
}

/** The house-org rule shared with messaging.ts isHouseOrganization. PURE. */
export function isHouseOrgRow(org: { plan: string | null; slug: string | null } | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(org && (org.plan === "internal" || org.slug === houseOrgSlug(env)));
}

/** Today's sender, verbatim (may be "Name <addr>"). */
function legacyFrom(env: NodeJS.ProcessEnv): string | null {
  return env.OUTBOUND_FROM_EMAIL || env.LEAD_FROM_EMAIL || null;
}

/** The platform sender (no company): EVERDOER_DEFAULT_FROM_EMAIL, else today's. */
export function platformFromAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.EVERDOER_DEFAULT_FROM_EMAIL?.trim() || legacyFrom(env);
}

/** The From for a company (null info = platform mail). `||` throughout: a blank variable falls back. */
export function resolveFromAddress(info: CompanySenderInfo | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const own = usableCompanyAddress(info?.own);
  if (own) return own;
  if (info?.house) return legacyFrom(env) || platformFromAddress(env);
  return platformFromAddress(env);
}

/** A company's address only if it's one plain address (the DB checks the shape too). */
function usableCompanyAddress(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v || !/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(v)) return null;
  return v;
}

export class CompanySenderUnavailableError extends Error {
  constructor(companyId: string, reason: string) {
    super(`Couldn't read the sending address for company ${companyId} (${reason}); not sending rather than guessing.`);
    this.name = "CompanySenderUnavailableError";
  }
}

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 5000;
const LOG_EVERY_MS = 60_000;
const cache = new Map<string, { info: CompanySenderInfo; at: number }>();
let lastLogAt = -Infinity;

async function readSenderInfo(admin: Admin, companyId: string, env: NodeJS.ProcessEnv): Promise<CompanySenderInfo> {
  const { data, error } = await admin.from("companies").select("organization_id, email_from_address").eq("id", companyId).maybeSingle();
  if (error) throw new Error(error.message);
  const company = data as { organization_id: string | null; email_from_address: string | null } | null;
  if (!company?.organization_id) throw new Error("company not found");
  const { data: org, error: orgError } = await admin.from("organizations").select("plan, slug").eq("id", company.organization_id).maybeSingle();
  if (orgError) throw new Error(orgError.message);
  if (!org) throw new Error("organization not found");
  return { own: usableCompanyAddress(company.email_from_address), house: isHouseOrgRow(org as { plan: string | null; slug: string | null }, env) };
}

/** The company's sender info (cached), or throws when it can't be read. */
export async function loadCompanySenderInfo(
  companyId: string,
  options: { admin?: Admin; now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CompanySenderInfo> {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const hit = cache.get(companyId);
  if (hit && now - hit.at < TTL_MS) return hit.info;
  const info = await readSenderInfo(options.admin ?? createSupabaseAdminClient(), companyId, env);
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(companyId, { info, at: now });
  return info;
}

/**
 * sendEmail's `fromAddress` for mail sent on a company's behalf: the resolved From when it differs
 * from the platform sender, else null (the message then goes out exactly as it would have).
 * Throws CompanySenderUnavailableError only when the read fails AND EVERDOER_DEFAULT_FROM_EMAIL is set.
 */
export async function loadCompanyFromAddress(
  companyId: string | null | undefined,
  options: { admin?: Admin; now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  if (!companyId) return null;
  const env = options.env ?? process.env;
  let info: CompanySenderInfo;
  try {
    info = await loadCompanySenderInfo(companyId, options);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const now = options.now ?? Date.now();
    const strict = Boolean(env.EVERDOER_DEFAULT_FROM_EMAIL?.trim());
    if (now - lastLogAt >= LOG_EVERY_MS) {
      lastLogAt = now;
      console.error(
        `[outbound] couldn't read the sender for company ${companyId}: ${reason}; ` +
          (strict ? "not sending (EVERDOER_DEFAULT_FROM_EMAIL is set)." : "sending from OUTBOUND_FROM_EMAIL as before."),
      );
    }
    if (strict) throw new CompanySenderUnavailableError(companyId, reason);
    return null; // platform sender = today's OUTBOUND_FROM_EMAIL || LEAD_FROM_EMAIL
  }
  const resolved = resolveFromAddress(info, env);
  return resolved && resolved !== platformFromAddress(env) ? resolved : null;
}

/** Tests only. */
export function resetCompanySenderCache(): void {
  cache.clear();
  lastLogAt = -Infinity;
}
