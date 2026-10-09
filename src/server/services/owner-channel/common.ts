/**
 * Owner channel plumbing (docs/front-desk-ai.md "## Owner by text"): who is an owner, the
 * platform-number opt-out, quiet hours, rate limits, and the one function that texts an owner.
 *
 * The owner's identity is the PHONE MATCH ONLY: companies.owner_phone_e164 (profiles carry no
 * phone in this schema). Everything the owner channel reads or changes is scoped to the
 * companies that phone owns — never to an id that arrived in a text.
 */
import type { Tables } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import type { TenantServiceContext } from "@/server/services/shared";
import { isPlatformOptedOut as isPlatformOptedOutShared } from "@/server/services/platform-opt-out";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";

export const DEFAULT_TIMEZONE = "America/Toronto";

export interface OwnerCompany {
  companyId: string;
  organizationId: string;
  name: string;
  timeZone: string;
  ownerPhone: string;
  platformBrand: string;
}

export function ctxFor(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin as TenantServiceContext["supabase"] };
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizePhoneLast10(a);
  const y = normalizePhoneLast10(b);
  return Boolean(x && y && x === y);
}

/** The deployment-wide platform number (TWILIO_FROM_NUMBER), if set. */
export function platformNumber(): string | null {
  return process.env.TWILIO_FROM_NUMBER?.trim() || null;
}

export function isPlatformNumber(to: string | null | undefined): boolean {
  const platform = platformNumber();
  return Boolean(platform && to && (platform === to.trim() || samePhone(platform, to)));
}

type CompanyRow = Pick<Tables<"companies">, "id" | "organization_id" | "name" | "timezone" | "owner_phone_e164" | "owner_phone_verified_at">;

/**
 * Two phones are the same owner phone: exact E.164, or — for NANP (+1) numbers only — the same
 * last 10 digits (a number stored as "705-555-0142"). Never a last-10 match across countries
 * (+44 20 7946 0958 and +1 207-946-0958 share no owner). PURE.
 */
export function sameOwnerPhone(stored: string | null | undefined, phone: string | null | undefined): boolean {
  const a = (stored ?? "").trim();
  const b = (phone ?? "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const digits = (x: string) => x.replace(/\D/g, "");
  const nanp = (x: string) => {
    const d = digits(x);
    if (x.startsWith("+")) return d.length === 11 && d.startsWith("1") ? d.slice(1) : null;
    if (d.length === 10) return d;
    if (d.length === 11 && d.startsWith("1")) return d.slice(1);
    return null;
  };
  const x = nanp(a);
  const y = nanp(b);
  if (x && y) return x === y;
  return a.startsWith("+") && b.startsWith("+") && digits(a) === digits(b);
}

/**
 * Every company whose VERIFIED owner phone is this phone (exact E.164 first, then the NANP
 * last-10 form for numbers stored in another format). Cross-tenant by design — this IS the
 * identity check. A number that was changed and not yet confirmed with the texted code
 * (owner_phone_verified_at null) is not an owner (owner-channel/owner-phone.ts).
 */
export async function findOwnerCompanies(admin: AdminClient, phone: string): Promise<OwnerCompany[]> {
  const last10 = normalizePhoneLast10(phone);
  if (!last10) return [];
  const columns = "id, organization_id, name, timezone, owner_phone_e164, owner_phone_verified_at";
  const exact = await admin.from("companies").select(columns).eq("owner_phone_e164", phone.trim()).limit(20);
  let rows = ((exact.data ?? []) as CompanyRow[]).filter((r) => sameOwnerPhone(r.owner_phone_e164, phone));
  const isNanp = /^\+1\d{10}$/.test(phone.trim()) || (!phone.trim().startsWith("+") && phone.replace(/\D/g, "").length === 10);
  if (rows.length === 0 && isNanp) {
    const loose = await admin.from("companies").select(columns).like("owner_phone_e164", `%${last10}`).limit(20);
    rows = ((loose.data ?? []) as CompanyRow[]).filter((r) => sameOwnerPhone(r.owner_phone_e164, phone));
  }
  rows = rows.filter((r) => Boolean(r.owner_phone_verified_at));
  if (rows.length === 0) return [];

  const orgIds = [...new Set(rows.map((r) => r.organization_id))];
  const { data: orgs } = await admin.from("organizations").select("id, platform_brand").in("id", orgIds);
  const brandOf = new Map(((orgs ?? []) as Array<{ id: string; platform_brand: string | null }>).map((o) => [o.id, o.platform_brand ?? "empirevu"]));

  return rows.map((r) => ({
    companyId: r.id,
    organizationId: r.organization_id,
    name: r.name,
    timeZone: r.timezone?.trim() || DEFAULT_TIMEZONE,
    ownerPhone: r.owner_phone_e164 ?? phone,
    platformBrand: brandOf.get(r.organization_id) ?? "empirevu",
  }));
}

/** Is this phone the owner of exactly this company? */
export async function isOwnerOfCompany(admin: AdminClient, phone: string, companyId: string): Promise<boolean> {
  const { data } = await admin.from("companies").select("id, owner_phone_e164, owner_phone_verified_at").eq("id", companyId).maybeSingle();
  const row = data as { owner_phone_e164: string | null; owner_phone_verified_at: string | null } | null;
  return Boolean(row && row.owner_phone_verified_at && sameOwnerPhone(row.owner_phone_e164, phone));
}

// ── Platform-number opt-out ──────────────────────────────────────────────────

export async function isPlatformOptedOut(admin: AdminClient, phone: string): Promise<boolean> {
  return isPlatformOptedOutShared(admin, phone);
}

export async function setPlatformOptOut(admin: AdminClient, phone: string, optedOut: boolean, sourceRef: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin.from("platform_sms_opt_outs").upsert(
    optedOut
      ? { phone_e164: phone.trim(), opted_out_at: now, source_ref: sourceRef }
      : { phone_e164: phone.trim(), opted_out_at: null, opted_in_at: now, source_ref: sourceRef },
    { onConflict: "phone_e164" },
  );
  if (error) throw error;
}

// ── Quiet hours (21:00–08:00 company local) ───────────────────────────────────

export function localHour(nowMs: number, timeZone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric" }).format(new Date(nowMs));
    return Number.parseInt(hour, 10) % 24;
  } catch {
    return localHour(nowMs, DEFAULT_TIMEZONE);
  }
}

export function isQuietHours(nowMs: number, timeZone: string): boolean {
  const hour = localHour(nowMs, timeZone);
  return hour >= 21 || hour < 8;
}

// ── Rate limits (consume_rate_limit; fail OPEN like the rest of the app) ─────

export async function consumeLimit(admin: AdminClient, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("consume_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
    if (error) throw error;
    return data !== false;
  } catch (err) {
    console.error("[owner-channel] rate limit check failed (allowing):", err instanceof Error ? err.message : err);
    return true;
  }
}

/** Owner alerts + approval texts per company per hour (everything past it is held / summarised). */
export const OWNER_ALERTS_PER_HOUR = 30;

/**
 * Per-company owner-alert budget: "send" while under OWNER_ALERTS_PER_HOUR; the first one over it
 * becomes ONE summary ("summary"); the rest are dropped this hour ("drop") — a flood of customer
 * texts (or a bot) can't turn into a flood of owner texts. Fails open.
 */
export async function ownerAlertGate(admin: AdminClient, companyId: string): Promise<"send" | "summary" | "drop"> {
  if (await consumeLimit(admin, `owner_alerts:${companyId}`, OWNER_ALERTS_PER_HOUR, 3600)) return "send";
  return (await consumeLimit(admin, `owner_alerts_over:${companyId}`, 1, 3600)) ? "summary" : "drop";
}

export const OWNER_ALERTS_SUMMARY =
  "Lots going on - I've sent you the most I will this hour. The rest are waiting in the app (Inbox and Approvals).";

// ── Texting the owner ─────────────────────────────────────────────────────────

// Approval texts (≤440 + code + instruction + a business name) must never be cut.
const MAX_OWNER_SMS = 700;

/** "CrankLeads: " for CrankLeads orgs; nothing otherwise (never "EmpireVu"). */
export function signaturePrefix(platformBrand: string | null | undefined): string {
  return platformBrand === "crankleads" ? "CrankLeads: " : "";
}

export interface OwnerSmsInput {
  to: string;
  body: string;
  organizationId: string;
  companyId: string | null;
  platformBrand?: string | null;
}

/**
 * Text a business owner from the PLATFORM number (never the company number, so a STOP to it
 * can't block the company's own number). Respects the platform opt-out (also enforced by
 * deliverMessage for every platform sender). Never throws.
 */
export async function sendOwnerSms(admin: AdminClient, input: OwnerSmsInput): Promise<{ status: "sent" | "failed" | "blocked"; reason?: string }> {
  try {
    if (await isPlatformOptedOut(admin, input.to)) return { status: "blocked", reason: "platform_opted_out" };
    let body = `${signaturePrefix(input.platformBrand)}${input.body.trim()}`;
    if (body.length > MAX_OWNER_SMS) body = `${body.slice(0, MAX_OWNER_SMS - 1)}…`;
    const result = await deliverMessage({
      context: ctxFor(admin, input.organizationId),
      channel: "sms",
      to: input.to,
      body,
      companyId: input.companyId,
      contactId: null,
      consentContact: null,
      smsFrom: "platform",
    });
    return { status: result.status, reason: result.reason };
  } catch (err) {
    console.error("[owner-channel] owner text failed:", err instanceof Error ? err.message : err);
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** "Thu Oct 9, 9:00 a.m." in the company's zone. */
export function shortWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-CA", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}
