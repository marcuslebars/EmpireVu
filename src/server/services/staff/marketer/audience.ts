/**
 * Who a win-back campaign texts: past customers of ONE company whose latest purchase (a
 * completed booking or a paid invoice) was monthsMin–monthsMax ago, ONE per phone number, minus
 * any number where
 *   - there's no phone, or ANY contact of the company with that number opted out (a STOP only
 *     opts out the contact it matched, so duplicates must not slip through), or the chosen
 *     contact has no CASL consent (checkConsent with the purchase date: 2 years from a purchase,
 *     6 months from an inquiry, express forever),
 *   - any contact with that number was texted (or is queued) by a campaign of this company in
 *     the last 90 days (counted from when it was sent, else when it was queued),
 *   - any contact with that number has an open booking or an open quote.
 * Every read is scoped by organization_id AND company_id and paged (PostgREST's 1,000-row cap).
 * The same checks run again per recipient right before each send (recipientBlocker), plus
 * "bought again since the draft".
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { normalizePhoneLast10 } from "@/server/services/lead-intake/matching";
import type { Db } from "@/server/services/staff/marketer/db-types";
import { pageAll } from "@/server/services/staff/marketer/paging";
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

export type ExclusionReason =
  | "no_phone"
  | "opted_out"
  | "no_consent"
  | "recent_campaign"
  | "open_booking"
  | "open_quote"
  | "duplicate_phone"
  | "recent_purchase";

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
  const groups: Array<string[] | null> = contactIds ? chunks(contactIds) : [null];
  for (const ids of groups) {
    if (ids && ids.length === 0) continue;
    const bookings = await pageAll<{ contact_id: string | null; completed_at: string | null; scheduled_for: string | null }>(() => {
      let q = db
        .from("bookings")
        .select("id, contact_id, completed_at, scheduled_for")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .eq("status", "completed");
      if (ids) q = q.in("contact_id", ids);
      return q.order("id", { ascending: true });
    });
    for (const row of bookings) add(row.contact_id, row.completed_at ?? row.scheduled_for);
    const invoices = await pageAll<{ contact_id: string | null; paid_at: string | null }>(() => {
      let q = db
        .from("invoices")
        .select("id, contact_id, paid_at")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .eq("status", "paid");
      if (ids) q = q.in("contact_id", ids);
      return q.order("id", { ascending: true });
    });
    for (const row of invoices) add(row.contact_id, row.paid_at);
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

/** Every contact of the company sharing one of these numbers (last 10 digits) → id, number, opt-out. */
async function siblingsByPhone(db: Db, scope: Scope, phones: string[]): Promise<Array<{ id: string; phone: string; optedOut: boolean }>> {
  const out: Array<{ id: string; phone: string; optedOut: boolean }> = [];
  for (const group of chunks(phones)) {
    const rows = await pageAll<{ id: string; phone: string | null; phone_last10: string | null; sms_opt_out_at: string | null }>(() =>
      db
        .from("contacts")
        .select("id, phone, phone_last10, sms_opt_out_at")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .in("phone_last10", group)
        .order("id", { ascending: true }),
    );
    for (const r of rows) {
      const phone = r.phone_last10 ?? normalizePhoneLast10(r.phone);
      if (phone) out.push({ id: r.id, phone, optedOut: Boolean(r.sms_opt_out_at) });
    }
  }
  return out;
}

/**
 * Contacts (of these) texted or queued by a campaign of the company in the cooldown window,
 * counted from sent_at (else created_at). In `current` (the campaign being sent), only rows
 * already sent / sending by OTHER contacts count — a sibling with the same number.
 */
async function recentlyCampaigned(db: Db, scope: Scope, ids: string[], nowMs: number, current: { campaignId: string; contactId: string } | null): Promise<Set<string>> {
  const since = nowMs - CAMPAIGN_COOLDOWN_DAYS * 86_400_000;
  const found = new Set<string>();
  for (const group of chunks(ids)) {
    const rows = await pageAll<{ contact_id: string; campaign_id: string; status: string; sent_at: string | null; created_at: string }>(() =>
      db
        .from("marketing_campaign_recipients")
        .select("id, contact_id, campaign_id, status, sent_at, created_at")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .in("contact_id", group)
        .in("status", ["queued", "sending", "sent"])
        .order("id", { ascending: true }),
    );
    for (const row of rows) {
      const at = Date.parse(row.sent_at ?? row.created_at);
      if (!(at >= since)) continue;
      if (current && row.campaign_id === current.campaignId) {
        if (row.contact_id === current.contactId || row.status === "queued") continue;
      }
      found.add(row.contact_id);
    }
  }
  return found;
}

async function idsWith(db: Db, build: (ids: string[]) => Db, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const group of chunks(ids)) {
    const rows = await pageAll<{ contact_id: string | null }>(() => build(group).order("id", { ascending: true }));
    for (const row of rows) if (row.contact_id) found.add(row.contact_id);
  }
  return found;
}

async function openWork(db: Db, scope: Scope, ids: string[], nowMs: number): Promise<{ bookings: Set<string>; quotes: Set<string> }> {
  const bookings = await idsWith(
    db,
    (group) =>
      db
        .from("bookings")
        .select("id, contact_id")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .in("contact_id", group)
        .in("status", OPEN_BOOKING_STATUSES),
    ids,
  );
  const quoteSince = new Date(nowMs - OPEN_QUOTE_MAX_AGE_DAYS * 86_400_000).toISOString();
  const quotes = await idsWith(
    db,
    (group) =>
      db
        .from("quotes")
        .select("id, contact_id")
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .in("contact_id", group)
        .in("status", OPEN_QUOTE_STATUSES)
        .gte("created_at", quoteSince),
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

/** Per number: is it opted out anywhere, campaigned recently, or has open work (across every contact with it)? */
async function numberBlockers(
  db: Db,
  scope: Scope,
  phones: string[],
  nowMs: number,
  current: { campaignId: string; contactId: string } | null,
): Promise<{ blockers: Map<string, ExclusionReason>; siblings: Array<{ id: string; phone: string }> }> {
  const siblings = await siblingsByPhone(db, scope, phones);
  const ids = [...new Set(siblings.map((s) => s.id))];
  const recent = ids.length ? await recentlyCampaigned(db, scope, ids, nowMs, current) : new Set<string>();
  const open = ids.length ? await openWork(db, scope, ids, nowMs) : { bookings: new Set<string>(), quotes: new Set<string>() };
  const blockers = new Map<string, ExclusionReason>();
  const rank: ExclusionReason[] = ["opted_out", "recent_campaign", "open_booking", "open_quote"];
  for (const s of siblings) {
    const reason: ExclusionReason | null = s.optedOut ? "opted_out" : recent.has(s.id) ? "recent_campaign" : open.bookings.has(s.id) ? "open_booking" : open.quotes.has(s.id) ? "open_quote" : null;
    if (!reason) continue;
    const prev = blockers.get(s.phone);
    if (!prev || rank.indexOf(reason) < rank.indexOf(prev)) blockers.set(s.phone, reason);
  }
  return { blockers, siblings };
}

export async function buildWinBackAudience(
  admin: AdminClient,
  scope: Scope,
  window: { monthsMin: number; monthsMax: number },
  nowMs: number,
  options: { limit?: number } = {},
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
  if (inWindow.length === 0) return { members: [], inWindow: 0, excluded };

  const contacts = new Map<string, ContactRow>();
  for (const group of chunks(inWindow.map(([id]) => id))) {
    const rows = await pageAll<ContactRow>(() =>
      db
        .from("contacts")
        .select(CONTACT_COLUMNS)
        .eq("organization_id", scope.organizationId)
        .eq("company_id", scope.companyId)
        .in("id", group)
        .order("id", { ascending: true }),
    );
    for (const c of rows) contacts.set(c.id, c);
  }
  const phones = [...new Set([...contacts.values()].map((c) => normalizePhoneLast10(c.phone)).filter((p): p is string => Boolean(p)))];
  const { blockers, siblings } = await numberBlockers(db, scope, phones, nowMs, null);
  // Someone who bought more recently under a duplicate contact isn't a past customer.
  const latestByPhone = new Map<string, number>();
  for (const s of siblings) {
    const at = purchases.get(s.id);
    if (at) latestByPhone.set(s.phone, Math.max(latestByPhone.get(s.phone) ?? 0, Date.parse(at)));
  }

  const members: AudienceMember[] = [];
  const taken = new Set<string>();
  for (const [contactId, lastPurchaseAt] of inWindow.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))) {
    const c = contacts.get(contactId);
    const phone = normalizePhoneLast10(c?.phone);
    if (!c || !phone || !c.phone) {
      bump("no_phone");
      continue;
    }
    if (taken.has(phone)) {
      bump("duplicate_phone");
      continue;
    }
    const blocker = blockers.get(phone);
    if (blocker) {
      bump(blocker);
      continue;
    }
    if ((latestByPhone.get(phone) ?? 0) > newest) {
      bump("recent_purchase");
      continue;
    }
    const consent = checkConsent({ ...c, last_purchase_at: lastPurchaseAt }, "sms", nowMs);
    if (!consent.ok) {
      bump(consent.reason === "opted_out" ? "opted_out" : "no_consent");
      continue;
    }
    taken.add(phone);
    members.push({ contactId, firstName: greetingName(c.first_name), phone: c.phone.trim(), lastPurchaseAt });
  }
  return { members: options.limit ? members.slice(0, options.limit) : members, inWindow: inWindow.length, excluded };
}

/**
 * Right before a send: is there now a reason not to text this person? Checks every contact of
 * the company with the same number (opt-out, cooldown, open booking / quote, another recipient
 * of this campaign already texted) and whether they bought again since the draft (latest
 * purchase newer than monthsMin ago). Consent itself is enforced again inside deliverMessage.
 */
export async function recipientBlocker(
  admin: AdminClient,
  scope: Scope,
  recipient: { contactId: string; phone: string; campaignId: string; monthsMin: number },
  nowMs: number,
): Promise<ExclusionReason | null> {
  const db = admin as Db;
  const phone = normalizePhoneLast10(recipient.phone);
  if (!phone) return "no_phone";
  const { blockers, siblings } = await numberBlockers(db, scope, [phone], nowMs, { campaignId: recipient.campaignId, contactId: recipient.contactId });
  const blocker = blockers.get(phone);
  if (blocker) return blocker;
  const ids = [...new Set([recipient.contactId, ...siblings.map((s) => s.id)])];
  const purchases = await latestPurchases(admin, scope, ids);
  const latest = Math.max(0, ...[...purchases.values()].map((at) => Date.parse(at)));
  if (latest > monthsAgo(nowMs, recipient.monthsMin)) return "recent_purchase";
  return null;
}

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  no_phone: "no mobile number",
  opted_out: "opted out",
  no_consent: "no consent to text",
  recent_campaign: "texted by a campaign in the last 90 days",
  open_booking: "already booked",
  open_quote: "has an open quote",
  duplicate_phone: "same number as another customer",
  recent_purchase: "bought again recently",
};
