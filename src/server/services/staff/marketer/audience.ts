/**
 * Who a win-back campaign texts: past customers of ONE company whose latest purchase (a
 * completed booking or a paid invoice) was monthsMin–monthsMax ago, minus anyone who
 *   - has no phone, opted out, or has no CASL consent (checkConsent with the purchase date:
 *     2 years from a purchase, 6 months from an inquiry, express forever),
 *   - was texted (or is queued) by any campaign of this company in the last 90 days,
 *   - has an open booking or an open quote.
 * Every read is scoped by organization_id AND company_id. The same checks run again per
 * recipient right before each send (recipientBlocker).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db } from "@/server/services/staff/marketer/db-types";
import { checkConsent } from "@/server/services/workflow-engine/messaging";

export const CAMPAIGN_COOLDOWN_DAYS = 90;
const OPEN_BOOKING_STATUSES = ["pending", "confirmed"];
const OPEN_QUOTE_STATUSES = ["sent", "viewed", "approved", "deposit_paid"];
/** An accepted quote older than this with no booking isn't "open" any more. */
const OPEN_QUOTE_MAX_AGE_DAYS = 180;
const CHUNK = 200;

export interface Scope {
  organizationId: string;
  companyId: string;
}

export interface AudienceMember {
  contactId: string;
  firstName: string | null;
  phone: string;
  lastPurchaseAt: string;
}

export type ExclusionReason = "no_phone" | "opted_out" | "no_consent" | "recent_campaign" | "open_booking" | "open_quote";

export interface AudienceResult {
  members: AudienceMember[];
  /** Past customers in the window before exclusions. */
  inWindow: number;
  excluded: Partial<Record<ExclusionReason, number>>;
}

export function monthsAgo(nowMs: number, months: number): number {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function later(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Latest purchase per contact for the company (completed bookings + paid invoices). */
export async function latestPurchases(admin: AdminClient, scope: Scope, contactIds?: string[]): Promise<Map<string, string>> {
  const db = admin as Db;
  const out = new Map<string, string>();
  const add = (contactId: string | null, at: string | null) => {
    if (!contactId || !at || !Number.isFinite(Date.parse(at))) return;
    const best = later(out.get(contactId), at);
    if (best) out.set(contactId, best);
  };
  const groups = contactIds ? chunks(contactIds) : [null];
  for (const ids of groups) {
    if (ids && ids.length === 0) continue;
    let bookings = db
      .from("bookings")
      .select("contact_id, completed_at, scheduled_for")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("status", "completed");
    if (ids) bookings = bookings.in("contact_id", ids);
    const { data: b, error: be } = await bookings.limit(10000);
    if (be) throw be;
    for (const row of (b ?? []) as Array<{ contact_id: string | null; completed_at: string | null; scheduled_for: string | null }>) {
      add(row.contact_id, row.completed_at ?? row.scheduled_for);
    }
    let invoices = db
      .from("invoices")
      .select("contact_id, paid_at")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("status", "paid");
    if (ids) invoices = invoices.in("contact_id", ids);
    const { data: inv, error: ie } = await invoices.limit(10000);
    if (ie) throw ie;
    for (const row of (inv ?? []) as Array<{ contact_id: string | null; paid_at: string | null }>) add(row.contact_id, row.paid_at);
  }
  return out;
}

interface ContactRow {
  id: string;
  first_name: string | null;
  phone: string | null;
  sms_opt_out_at: string | null;
  email_opt_out_at: string | null;
  sms_consent_at: string | null;
  consent_source: string | null;
}

const CONTACT_COLUMNS = "id, first_name, phone, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source";

async function idsWith(db: Db, query: (ids: string[]) => Promise<{ data: unknown; error: unknown }>, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunks(ids)) {
    const { data, error } = await query(group);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ contact_id: string | null }>) if (row.contact_id) found.add(row.contact_id);
  }
  return found;
}

/** Contacts (of these) texted or queued by any campaign of the company in the cooldown window. */
async function recentlyCampaigned(db: Db, scope: Scope, ids: string[], nowMs: number, excludeCampaignId: string | null): Promise<Set<string>> {
  const since = new Date(nowMs - CAMPAIGN_COOLDOWN_DAYS * 86_400_000).toISOString();
  const found = new Set<string>();
  for (const group of chunks(ids)) {
    const { data, error } = await db
      .from("marketing_campaign_recipients")
      .select("contact_id, campaign_id, status, sent_at, created_at")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .in("contact_id", group)
      .in("status", ["queued", "sending", "sent"])
      .gte("created_at", since)
      .limit(10000);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ contact_id: string; campaign_id: string; status: string; sent_at: string | null }>) {
      if (excludeCampaignId && row.campaign_id === excludeCampaignId) continue;
      found.add(row.contact_id);
    }
  }
  return found;
}

async function openWork(db: Db, scope: Scope, ids: string[], nowMs: number): Promise<{ bookings: Set<string>; quotes: Set<string> }> {
  const bookings = await idsWith(
    db,
    (group) =>
      db
        .from("bookings")
        .select("contact_id")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .in("contact_id", group)
        .in("status", OPEN_BOOKING_STATUSES)
        .limit(10000),
    ids,
  );
  const quoteSince = new Date(nowMs - OPEN_QUOTE_MAX_AGE_DAYS * 86_400_000).toISOString();
  const quotes = await idsWith(
    db,
    (group) =>
      db
        .from("quotes")
        .select("contact_id")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .in("contact_id", group)
        .in("status", OPEN_QUOTE_STATUSES)
        .gte("created_at", quoteSince)
        .limit(10000),
    ids,
  );
  return { bookings, quotes };
}

/** A first name worth greeting by (not a phone number placeholder). */
export function greetingName(firstName: string | null | undefined): string | null {
  const name = (firstName ?? "").trim();
  if (!name || /\d/.test(name) || name.length > 30) return null;
  return name.split(/\s+/)[0];
}

export async function buildWinBackAudience(
  admin: AdminClient,
  scope: Scope,
  window: { monthsMin: number; monthsMax: number },
  nowMs: number,
  options: { limit?: number; excludeCampaignId?: string | null } = {},
): Promise<AudienceResult> {
  const db = admin as Db;
  const newest = monthsAgo(nowMs, window.monthsMin);
  const oldest = monthsAgo(nowMs, window.monthsMax);
  const purchases = await latestPurchases(admin, scope);
  const inWindow = [...purchases.entries()].filter(([, at]) => {
    const ms = Date.parse(at);
    return ms <= newest && ms >= oldest;
  });
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  const bump = (r: ExclusionReason) => {
    excluded[r] = (excluded[r] ?? 0) + 1;
  };
  const ids = inWindow.map(([id]) => id);
  if (ids.length === 0) return { members: [], inWindow: 0, excluded };

  const contacts = new Map<string, ContactRow>();
  for (const group of chunks(ids)) {
    const { data, error } = await db
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .in("id", group)
      .limit(CHUNK);
    if (error) throw error;
    for (const c of (data ?? []) as ContactRow[]) contacts.set(c.id, c);
  }
  const recent = await recentlyCampaigned(db, scope, ids, nowMs, options.excludeCampaignId ?? null);
  const open = await openWork(db, scope, ids, nowMs);

  const members: AudienceMember[] = [];
  for (const [contactId, lastPurchaseAt] of inWindow.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))) {
    const c = contacts.get(contactId);
    if (!c || !c.phone?.trim()) {
      bump("no_phone");
      continue;
    }
    const consent = checkConsent({ ...c, last_purchase_at: lastPurchaseAt }, "sms", nowMs);
    if (!consent.ok) {
      bump(consent.reason === "opted_out" ? "opted_out" : "no_consent");
      continue;
    }
    if (recent.has(contactId)) {
      bump("recent_campaign");
      continue;
    }
    if (open.bookings.has(contactId)) {
      bump("open_booking");
      continue;
    }
    if (open.quotes.has(contactId)) {
      bump("open_quote");
      continue;
    }
    members.push({ contactId, firstName: greetingName(c.first_name), phone: c.phone.trim(), lastPurchaseAt });
  }
  return { members: options.limit ? members.slice(0, options.limit) : members, inWindow: inWindow.length, excluded };
}

/**
 * Right before a send: is there now a reason not to text this person? Returns the reason, or
 * null to go ahead (consent itself is enforced again inside deliverMessage).
 */
export async function recipientBlocker(admin: AdminClient, scope: Scope, contactId: string, campaignId: string, nowMs: number): Promise<ExclusionReason | null> {
  const db = admin as Db;
  if ((await recentlyCampaigned(db, scope, [contactId], nowMs, campaignId)).size > 0) return "recent_campaign";
  const open = await openWork(db, scope, [contactId], nowMs);
  if (open.bookings.size > 0) return "open_booking";
  if (open.quotes.size > 0) return "open_quote";
  return null;
}

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  no_phone: "no mobile number",
  opted_out: "opted out",
  no_consent: "no consent to text",
  recent_campaign: "texted by a campaign in the last 90 days",
  open_booking: "already booked",
  open_quote: "has an open quote",
};
