/**
 * Follow every front-desk quote until it's booked: text nudges at +2d, +5d and +10d after it
 * was sent (settings cadence), the last one offering a call or the booking link.
 *
 * Which quotes: quotes.source 'estimator' (this role) or 'sms_agent' (the texting AI), status
 * sent / viewed. Only 09:00–20:00 company local. A nudge is skipped when its time passed more
 * than 2 days ago (a worker outage, or the feature switched on later) — never a burst.
 *
 * Stops for good when: the quote is approved / deposit paid / completed / expired / cancelled
 * (it leaves the scan), the customer booked, the customer texted since the last nudge (an
 * "ok thanks" right after the quote doesn't count), the conversation is with the owner (or the
 * AI is paused for them), the customer opted out (or consent blocks the text), a newer
 * front-desk quote went to the same customer, or every nudge went out.
 *
 * No double-up with the `quote-follow-up` recipe (SMS at +2d, email at +5d, then an owner
 * task): companies store a COPY of a recipe's definition when it's installed and the engine has
 * no per-step conditions, so the recipe can't be edited to skip a step for existing companies.
 * Instead, when that automation is active for the company, the estimator leaves the +2d text to
 * it and sends only the later nudges (the recipe's email and owner task are untouched).
 *
 * Idempotent: quote_follow_ups (unique quote_id) is the claim — nudges_sent moves n → n+1 with
 * a conditional update before the text is sent, so overlapping workers send each nudge once.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { quoteLinkForCompanyId } from "@/server/services/quotes/public-url";
import { effectiveState, findConversation } from "@/server/services/sms-agent/conversation";
import type { BusinessFacts } from "@/server/services/sms-agent/facts";
import { finalizeCustomerText, isAcknowledgement } from "@/server/services/sms-agent/guard";
import type { FollowedQuote, QuoteFollowUpRow } from "@/server/services/staff/estimator/db-types";
import { ESTIMATOR_QUOTE_SOURCE, estimatorDeps, type EstimatorContact, type EstimatorDeps } from "@/server/services/staff/estimator/deps";
import { followUpsActive, readEstimatorSettings } from "@/server/services/staff/estimator/settings";
import { DEFAULT_TIMEZONE, firstName, withinCustomerHours } from "@/server/services/staff/estimator/text";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export const FOLLOWED_QUOTE_SOURCES = [ESTIMATOR_QUOTE_SOURCE, "sms_agent"] as const;
export const QUOTE_FOLLOW_UP_RECIPE = "quote-follow-up";
const OPEN_QUOTE_STATUSES = ["sent", "viewed"];
const DAY_MS = 86_400_000;
/** A nudge whose time passed longer ago than this is skipped, not sent late. */
export const LATE_NUDGE_GRACE_MS = 2 * DAY_MS;
/** Never two nudges to one customer closer than this. */
const MIN_NUDGE_GAP_MS = 20 * 3_600_000;
const OWNER_TAKEOVER_MS = 72 * 3_600_000;
/** Keyset page size (PostgREST caps a response at 1000 rows anyway) and pages per pass. */
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export type StopReason =
  | "booked"
  | "customer_replied"
  | "owner_handling"
  | "opted_out"
  | "newer_quote"
  | "all_nudges_sent"
  | "too_late"
  | "no_contact"
  | "quote_closed"
  | `blocked:${string}`;

export interface FollowUpSweepResult {
  sent: number;
  stopped: number;
  skipped: number;
}

interface CompanyCtx {
  organizationId: string;
  companyId: string;
  timeZone: string;
  cadenceDays: number[];
  recipeActive: boolean;
  facts: BusinessFacts;
}

// ── the texts (PURE) ──────────────────────────────────────────────────────────────

/** The nudge for step `index` of `total`. The last one offers a call or the booking link. PURE. */
export function nudgeText(input: {
  index: number;
  total: number;
  firstName: string;
  businessName: string;
  ownerFirstName: string | null;
  title: string | null;
  quoteUrl: string;
  bookingUrl: string | null;
}): string {
  const job = input.title?.trim() ? ` for ${input.title.trim()}` : "";
  const hi = `Hi ${input.firstName}`;
  if (input.index >= input.total - 1) {
    const who = input.ownerFirstName ?? "we";
    const call = input.ownerFirstName ? `${who} can give you a quick call` : "we can give you a quick call";
    const book = input.bookingUrl ? ` or pick a time that suits you here: ${input.bookingUrl}` : " or reply with a day that works and we'll book you in";
    return `${hi}, last check-in from ${input.businessName} about your quote${job}: ${input.quoteUrl} Any questions? Just reply and ${call}${book}.`;
  }
  if (input.index === 0) {
    return `${hi}, it's ${input.businessName}. Just checking you got your quote${job}. You can look it over and approve it here: ${input.quoteUrl} Any questions, just reply.`;
  }
  return `${hi}, ${input.businessName} here. Still happy to take care of this for you - your quote${job} is here when you're ready: ${input.quoteUrl}`;
}

// ── DB helpers ────────────────────────────────────────────────────────────────────

async function followUpRow(admin: AdminClient, quote: FollowedQuote & { company_id: string }): Promise<QuoteFollowUpRow | null> {
  const db = admin as Db;
  const read = async () => {
    const { data } = await db.from("quote_follow_ups").select("*").eq("company_id", quote.company_id).eq("quote_id", quote.id).maybeSingle();
    return (data as QuoteFollowUpRow | null) ?? null;
  };
  const existing = await read();
  if (existing) return existing;
  const { data, error } = await db
    .from("quote_follow_ups")
    .insert({ organization_id: quote.organization_id, company_id: quote.company_id, contact_id: quote.contact_id, quote_id: quote.id, nudges_sent: 0 })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return read();
    throw error;
  }
  return data as QuoteFollowUpRow;
}

async function stop(admin: AdminClient, row: QuoteFollowUpRow, reason: StopReason, nowIso: string): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("quote_follow_ups")
    .update({ stopped_at: nowIso, stop_reason: reason })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .is("stopped_at", null)
    .select("id");
  return ((data ?? []) as unknown[]).length === 1;
}

/** Move nudges_sent from `from` to `to` (only one worker wins). */
async function advance(admin: AdminClient, row: QuoteFollowUpRow, from: number, to: number, patch: Record<string, unknown>): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("quote_follow_ups")
    .update({ nudges_sent: to, ...patch })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .eq("nudges_sent", from)
    .is("stopped_at", null)
    .select("id");
  return ((data ?? []) as unknown[]).length === 1;
}

async function loadContact(admin: AdminClient, quote: FollowedQuote & { company_id: string; contact_id: string }): Promise<EstimatorContact | null> {
  const { data } = await (admin as Db)
    .from("contacts")
    .select("id, organization_id, company_id, first_name, last_name, phone, sms_opt_out_at, email_opt_out_at, sms_consent_at, consent_source")
    .eq("organization_id", quote.organization_id)
    .eq("company_id", quote.company_id)
    .eq("id", quote.contact_id)
    .maybeSingle();
  return (data as EstimatorContact | null) ?? null;
}

async function hasBooking(admin: AdminClient, quote: FollowedQuote & { company_id: string; contact_id: string }): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("bookings")
    .select("id, quote_id, created_at, status")
    .eq("organization_id", quote.organization_id)
    .eq("company_id", quote.company_id)
    .eq("contact_id", quote.contact_id)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(20);
  const sentAt = quote.sent_at ?? "";
  return ((data ?? []) as Array<{ quote_id: string | null; created_at: string | null }>).some((b) => b.quote_id === quote.id || (b.created_at ?? "") >= sentAt);
}

/** Did the customer text since `sinceIso`? Before the first nudge, a bare "ok thanks" doesn't count. */
async function customerTextedSince(admin: AdminClient, quote: FollowedQuote & { company_id: string; contact_id: string }, sinceIso: string, ignoreAcks: boolean): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("message_log")
    .select("id, body, created_at")
    .eq("organization_id", quote.organization_id)
    .eq("contact_id", quote.contact_id)
    .eq("channel", "sms")
    .eq("direction", "inbound")
    .gt("created_at", sinceIso)
    .limit(20);
  return ((data ?? []) as Array<{ body: string | null }>).some((m) => !(ignoreAcks && isAcknowledgement(m.body ?? "")));
}

async function companyContext(admin: AdminClient, deps: EstimatorDeps, companyId: string): Promise<CompanyCtx | null> {
  const db = admin as Db;
  const { data: company } = await db.from("companies").select("id, organization_id, timezone, ai_settings").eq("id", companyId).maybeSingle();
  const c = company as { id: string; organization_id: string; timezone: string | null; ai_settings: unknown } | null;
  if (!c) return null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", c.organization_id).maybeSingle();
  const settings = readEstimatorSettings(c.ai_settings, { crankleads: (org as { platform_brand: string | null } | null)?.platform_brand === "crankleads" });
  if (!followUpsActive(settings)) return null;
  const { data: workflows } = await db
    .from("workflows")
    .select("id, company_id, status")
    .eq("organization_id", c.organization_id)
    .eq("slug", QUOTE_FOLLOW_UP_RECIPE)
    .eq("status", "active")
    .limit(10);
  const recipeActive = ((workflows ?? []) as Array<{ company_id: string | null }>).some((w) => w.company_id === null || w.company_id === c.id);
  // Without the business's facts a nudge would say "it's us" — skip the company this pass.
  const facts = await deps.loadFacts(admin, c.id).catch(() => null);
  if (!facts) return null;
  return {
    organizationId: c.organization_id,
    companyId: c.id,
    timeZone: c.timezone?.trim() || DEFAULT_TIMEZONE,
    cadenceDays: settings.cadenceDays,
    recipeActive,
    facts,
  };
}

// ── one quote ─────────────────────────────────────────────────────────────────────

type Outcome = "sent" | "stopped" | "skipped" | "waiting";

async function followOne(
  admin: AdminClient,
  deps: EstimatorDeps,
  ctx: CompanyCtx,
  quote: FollowedQuote & { company_id: string },
  newerForContact: boolean,
  now: Date,
): Promise<Outcome> {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const row = await followUpRow(admin, quote);
  if (!row || row.stopped_at) return "waiting";
  if (!quote.contact_id || !quote.sent_at) return (await stop(admin, row, "no_contact", nowIso)) ? "stopped" : "waiting";
  const q = quote as FollowedQuote & { company_id: string; contact_id: string; sent_at: string };

  if (newerForContact) return (await stop(admin, row, "newer_quote", nowIso)) ? "stopped" : "waiting";
  const index = row.nudges_sent;
  const total = ctx.cadenceDays.length;
  if (index >= total) return (await stop(admin, row, "all_nudges_sent", nowIso)) ? "stopped" : "waiting";

  const dueMs = Date.parse(q.sent_at) + ctx.cadenceDays[index] * DAY_MS;
  if (nowMs < dueMs) return "waiting";

  // Stop conditions (checked only when a nudge is due — cheap otherwise).
  const contact = await loadContact(admin, q);
  if (!contact) return (await stop(admin, row, "no_contact", nowIso)) ? "stopped" : "waiting";
  if (contact.sms_opt_out_at) return (await stop(admin, row, "opted_out", nowIso)) ? "stopped" : "waiting";
  if (await hasBooking(admin, q)) return (await stop(admin, row, "booked", nowIso)) ? "stopped" : "waiting";
  const conv = await findConversation(admin, { companyId: q.company_id, contactId: q.contact_id });
  if (conv) {
    const state = effectiveState(conv, now, OWNER_TAKEOVER_MS);
    if (state === "owner" || state === "paused") return (await stop(admin, row, "owner_handling", nowIso)) ? "stopped" : "waiting";
  }
  const since = row.last_nudge_at ?? q.sent_at;
  if (await customerTextedSince(admin, q, since, index === 0)) return (await stop(admin, row, "customer_replied", nowIso)) ? "stopped" : "waiting";

  // The recipe already texts at +2d for this company: leave the first nudge to it.
  if (index === 0 && ctx.recipeActive) {
    const moved = await advance(admin, row, 0, 1, { last_nudge_at: nowIso, last_error: "first nudge left to the quote-follow-up automation" });
    return moved ? "skipped" : "waiting";
  }
  // Too late for this nudge: skip it (the last one → stop), never send a burst.
  if (nowMs - dueMs > LATE_NUDGE_GRACE_MS) {
    if (index >= total - 1) return (await stop(admin, row, "too_late", nowIso)) ? "stopped" : "waiting";
    return (await advance(admin, row, index, index + 1, { last_error: `nudge ${index + 1} skipped (late)` })) ? "skipped" : "waiting";
  }
  if (row.last_nudge_at && nowMs - Date.parse(row.last_nudge_at) < MIN_NUDGE_GAP_MS) return "waiting";

  // Claim, then send.
  if (!(await advance(admin, row, index, index + 1, { last_nudge_at: nowIso, last_error: null }))) return "waiting";
  const facts = ctx.facts;
  const businessName = facts.businessName;
  const url = await quoteLinkForCompanyId(q.company_id, q.public_token, admin as Db);
  const text = finalizeCustomerText(
    nudgeText({
      index,
      total,
      firstName: firstName(contact),
      businessName,
      ownerFirstName: facts.ownerFirstName ?? null,
      title: q.title,
      quoteUrl: url,
      bookingUrl: facts.bookingUrl ?? null,
    }),
    { businessName, links: [url, ...(facts.bookingUrl && index >= total - 1 ? [facts.bookingUrl] : [])], allowed: [url, ...(facts.bookingUrl ? [facts.bookingUrl] : [])] },
  );
  const result = await deps.textCustomer(admin, { organizationId: q.organization_id, companyId: q.company_id }, contact, text);
  if (result.status === "blocked") {
    await stop(admin, row, `blocked:${result.reason ?? "blocked"}`, nowIso);
    return "stopped";
  }
  if (result.status === "failed") {
    await (admin as Db).from("quote_follow_ups").update({ last_error: `nudge ${index + 1} failed: ${(result.reason ?? "").slice(0, 200)}` }).eq("id", row.id);
    return "skipped";
  }
  if (index + 1 >= total) await stop(admin, row, "all_nudges_sent", nowIso);
  return "sent";
}

// ── the sweep ─────────────────────────────────────────────────────────────────────

type ScannedQuote = FollowedQuote & { company_id: string };

async function chunked<T>(ids: string[], size: number, read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await read(ids.slice(i, i + size))));
  return out;
}

/**
 * Close follow-up rows whose quote left sent/viewed (approved, paid, expired, cancelled, gone),
 * so counts (Settings, pending_estimates) don't overstate. Keyset-paged over open rows.
 */
async function closeFinishedFollowUps(admin: AdminClient, nowIso: string): Promise<number> {
  const db = admin as Db;
  let closed = 0;
  let after: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = db.from("quote_follow_ups").select("id, company_id, quote_id, created_at").is("stopped_at", null).order("created_at", { ascending: true }).limit(PAGE_SIZE);
    if (after) query = query.gte("created_at", after);
    const { data, error } = await query;
    if (error) throw error;
    const all = (data ?? []) as Array<{ id: string; company_id: string; quote_id: string; created_at: string }>;
    const rows = all.filter((r) => !seen.has(r.id));
    for (const r of rows) seen.add(r.id);
    if (rows.length === 0) break;
    const quotes = await chunked(rows.map((r) => r.quote_id), 200, async (ids) => {
      const { data: q } = await db.from("quotes").select("id, status, deposit_paid_at").in("id", ids);
      return (q ?? []) as Array<{ id: string; status: string; deposit_paid_at: string | null }>;
    });
    const open = new Set(quotes.filter((q) => OPEN_QUOTE_STATUSES.includes(q.status) && !q.deposit_paid_at).map((q) => q.id));
    for (const r of rows) {
      if (open.has(r.quote_id)) continue;
      const { data: done } = await db
        .from("quote_follow_ups")
        .update({ stopped_at: nowIso, stop_reason: "quote_closed" })
        .eq("id", r.id)
        .eq("company_id", r.company_id)
        .is("stopped_at", null)
        .select("id");
      closed += ((done ?? []) as unknown[]).length;
    }
    if (all.length < PAGE_SIZE || !all[all.length - 1].created_at) break;
    after = all[all.length - 1].created_at;
  }
  return closed;
}

export async function sweepQuoteFollowUps(admin: AdminClient, nowMs: number, deps: EstimatorDeps = estimatorDeps()): Promise<FollowUpSweepResult> {
  const out: FollowUpSweepResult = { sent: 0, stopped: 0, skipped: 0 };
  const now = new Date(nowMs);
  const nowIso = now.toISOString();
  const db = admin as Db;
  out.stopped += await closeFinishedFollowUps(admin, nowIso).catch((err: unknown) => {
    console.error("[estimator] closing finished follow-ups failed:", err instanceof Error ? err.message : err);
    return 0;
  });

  // Every open front-desk quote in the window, keyset-paged by sent_at (oldest first), so new
  // quotes are never starved. Companies are checked once per pass (cached): disabled / house-org
  // companies and companies outside 09:00-20:00 drop out before any per-quote work, and quotes
  // whose follow-up already stopped are skipped. The longest cadence is 30 days; 33 covers the
  // late grace.
  const companyCtx = new Map<string, CompanyCtx | null>();
  const byCompany = new Map<string, ScannedQuote[]>();
  // Keyset on sent_at with gte + the ids already seen, so quotes sharing a timestamp across a
  // page boundary aren't lost.
  let after = new Date(nowMs - 33 * DAY_MS).toISOString();
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db
      .from("quotes")
      .select("id, organization_id, company_id, contact_id, status, source, title, public_token, subtotal_cents, sent_at, deposit_paid_at")
      .in("source", [...FOLLOWED_QUOTE_SOURCES])
      .in("status", OPEN_QUOTE_STATUSES)
      .gte("sent_at", after)
      .order("sent_at", { ascending: true })
      .limit(PAGE_SIZE);
    if (error) throw error;
    const all = (data ?? []) as FollowedQuote[];
    const rows = all.filter((q) => !seen.has(q.id));
    for (const q of rows) seen.add(q.id);
    if (rows.length === 0) break;
    const candidates: ScannedQuote[] = [];
    for (const q of rows) {
      if (!q.company_id || q.deposit_paid_at) continue;
      if (!companyCtx.has(q.company_id)) {
        let ctx: CompanyCtx | null = null;
        try {
          ctx = await companyContext(admin, deps, q.company_id);
        } catch (err) {
          console.error("[estimator] follow-up company check failed", q.company_id, err instanceof Error ? err.message : err);
        }
        companyCtx.set(q.company_id, ctx && withinCustomerHours(now, ctx.timeZone) ? ctx : null);
      }
      if (companyCtx.get(q.company_id)) candidates.push(q as ScannedQuote);
    }
    const stopped = new Set(
      (
        await chunked(candidates.map((q) => q.id), 200, async (ids) => {
          const { data: f } = await db.from("quote_follow_ups").select("quote_id, stopped_at").in("quote_id", ids).not("stopped_at", "is", null);
          return (f ?? []) as Array<{ quote_id: string }>;
        })
      ).map((f) => f.quote_id),
    );
    for (const q of candidates) if (!stopped.has(q.id)) byCompany.set(q.company_id, [...(byCompany.get(q.company_id) ?? []), q]);
    if (all.length < PAGE_SIZE) break;
    after = all[all.length - 1].sent_at ?? after;
  }

  for (const [companyId, list] of byCompany) {
    const ctx = companyCtx.get(companyId);
    if (!ctx) continue;
    // Only the newest front-desk quote per customer is followed.
    const newest = new Map<string, string>();
    for (const q of list) if (q.contact_id && q.sent_at && (newest.get(q.contact_id) ?? "") < q.sent_at) newest.set(q.contact_id, q.sent_at);
    for (const q of list) {
      const newer = Boolean(q.contact_id && q.sent_at && (newest.get(q.contact_id) ?? "") > q.sent_at);
      try {
        const outcome = await followOne(admin, deps, ctx, q, newer, now);
        if (outcome === "sent") out.sent++;
        else if (outcome === "stopped") out.stopped++;
        else if (outcome === "skipped") out.skipped++;
      } catch (err) {
        console.error("[estimator] follow-up failed for quote", q.id, err instanceof Error ? err.message : err);
      }
    }
  }
  return out;
}
