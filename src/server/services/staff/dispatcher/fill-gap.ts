/**
 * Filling the gap: when a job in the next 48 hours is cancelled or moved away (any path — the
 * app, the owner by text, the customer's own visit page), the owner gets a fill_gap approval:
 * "Sam Lee cancelled Thu 9am. Offer it to Jo Park (booked Fri 2pm)?". On Y, Jo gets a text
 * offering the earlier time with their manage link — they switch on their visit page
 * (visits/public.ts); nothing moves on its own.
 *
 * Because the customer takes the slot on the visit page, a gap is only offered when that page
 * can actually show and take it: the company lets customers move visits (visit_settings
 * allowReschedule), the gap is beyond the change cutoff (cutoffHours, default 24; hourly
 * companies also their minimum notice), it's one of the page's open times for the candidate's
 * visit (same grid, same busy rules), and the candidate's own visit can still be changed.
 * This is checked when asking, again on Y, and again before a queued offer goes out.
 *
 * The candidate: the soonest LATER booking (within 14 days) of a similar length, whose customer
 * can be texted and hasn't been offered a gap in the last 7 days.
 * Detected from recent booking.status_changed (→ cancelled) / booking.rescheduled activity
 * events of companies with the switch on, newest first; one claim per vacated slot
 * (dispatch_runs kind fill_gap), so it's asked once. Slots the Dispatcher itself emptied
 * (weather / day moves) are pre-claimed and never offered.
 */
import type { Tables } from "@/server/db/database.types";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { parseBookingPolicy } from "@/server/services/booking-windows";
import { parseOnlineBookingSettings } from "@/server/services/scheduling/rules";
import { parseVisitSettings, visitActions } from "@/server/services/visits/rules";
import { createDispatchApproval, defaultDispatchApprovalDeps, FILL_GAP_KIND, type DispatchApprovalDeps } from "./approvals";
import { loadDispatchCompany, manageUrl, type DispatchCompany } from "./company";
import type { Db } from "./db-types";
import { firstName, greeting, jobPhrase, nextSendMs, sendOrQueue, type SendCheck } from "./messages";
import { gapRunKey, LINK_PLACEHOLDER } from "./moves";
import { loadSlotContext, openSlotsFor, type SlotContext } from "./slots";
import { sentence, shortLabel, timeLabel, whenLabel } from "./time";

const HOUR = 3_600_000;
export const GAP_HORIZON_MS = 48 * HOUR;
/** Gaps starting sooner than this aren't worth offering. */
export const GAP_MIN_LEAD_MS = 2 * HOUR;
export const GAP_LOOKBACK_MS = 3 * HOUR;
export const OFFER_COOLDOWN_MS = 7 * 86_400_000;
const CANDIDATE_HORIZON_MS = 14 * 86_400_000;
const EVENTS_PER_QUERY = 200;

export interface Gap {
  vacatedBookingId: string;
  startsAt: string;
  durationMinutes: number;
  windowKey: string | null;
  reason: "cancelled" | "moved";
  who: string;
}

export interface GapCandidate {
  bookingId: string;
  contactId: string;
  who: string;
  firstName: string;
  job: string;
  startsAt: string;
  durationMinutes: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** PURE: the customer's offer text. */
export function gapOfferText(input: { businessName: string; candidate: Pick<GapCandidate, "firstName" | "job" | "startsAt">; gapStartsAt: string; timeZone: string; link: string | null }): string {
  const ask = input.link ? `Want it? You can switch here: ${input.link}` : "Want it? Just reply here.";
  return `${greeting(input.candidate.firstName)}, it's ${input.businessName}. ${sentence(`A spot opened up on ${whenLabel(input.gapStartsAt, input.timeZone)}, earlier than your ${input.candidate.job} on ${whenLabel(input.candidate.startsAt, input.timeZone)}`)} ${ask}`;
}

/** PURE: the owner's approval text (≤ 500). */
export function gapSummary(gap: Gap, candidate: GapCandidate, businessName: string, timeZone: string, nowMs?: number): string {
  const at = (iso: string) => shortLabel(iso, timeZone, nowMs);
  const what = gap.reason === "cancelled" ? `${gap.who} cancelled ${at(gap.startsAt)}.` : `${gap.who} moved off ${at(gap.startsAt)}.`;
  const text = gapOfferText({ businessName, candidate, gapStartsAt: gap.startsAt, timeZone, link: LINK_PLACEHOLDER });
  return `${what} Offer it to ${candidate.who} (booked ${at(candidate.startsAt)})? They'd get: "${text}"`.slice(0, 500);
}

function overlaps(aStart: number, aMinutes: number, bStart: number, bMinutes: number): boolean {
  return aStart < bStart + Math.max(1, bMinutes) * 60_000 && bStart < aStart + Math.max(1, aMinutes) * 60_000;
}

type BookingRow = Pick<
  Tables<"bookings">,
  "id" | "contact_id" | "title" | "scheduled_for" | "duration_minutes" | "window_key" | "status" | "en_route_at" | "started_at" | "manage_token" | "customer_confirmed_at"
>;
const BOOKING_COLUMNS = "id, contact_id, title, scheduled_for, duration_minutes, window_key, status, en_route_at, started_at, manage_token, customer_confirmed_at";

// ── Can the visit page take this gap? ────────────────────────────────────────

/** What the customer's visit page allows for this company (visits/public.ts rules). */
export interface VisitPageRules {
  allowReschedule: boolean;
  cutoffHours: number;
  /** How far ahead the page's first open time is (cutoff, and hourly companies' notice). */
  leadHours: number;
  settings: ReturnType<typeof parseVisitSettings>;
}

export async function loadVisitPageRules(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">): Promise<VisitPageRules> {
  const { data } = await (admin as Db)
    .from("companies")
    .select("visit_settings, booking_policy, online_booking_settings")
    .eq("organization_id", company.organizationId)
    .eq("id", company.companyId)
    .maybeSingle();
  const row = data as { visit_settings: unknown; booking_policy: unknown; online_booking_settings: unknown } | null;
  const settings = parseVisitSettings(row?.visit_settings);
  const policy = parseBookingPolicy(row?.booking_policy ?? null);
  const hourly = parseOnlineBookingSettings(row?.online_booking_settings);
  return { allowReschedule: settings.allowReschedule, cutoffHours: settings.cutoffHours, leadHours: Math.max(settings.cutoffHours, policy ? 0 : hourly.minNoticeHours), settings };
}

/** Could ANY visit move into this gap on the visit page right now (switch on, beyond the cutoff)? */
export function gapBeyondCutoff(rules: VisitPageRules, gapStartsAt: string, nowMs: number): boolean {
  return rules.allowReschedule && Date.parse(gapStartsAt) >= nowMs + rules.leadHours * HOUR;
}

/**
 * Would this candidate's visit page offer the gap? Its visit can still be changed, and the gap is
 * one of its open times (the page's grid and busy rules, the cutoff as earliest time).
 */
export function candidateCanTakeGap(rules: VisitPageRules, slots: SlotContext, gap: Pick<Gap, "startsAt" | "windowKey">, candidate: BookingRow, nowMs: number): boolean {
  if (!gapBeyondCutoff(rules, gap.startsAt, nowMs)) return false;
  const actions = visitActions(
    {
      status: candidate.status,
      scheduledFor: candidate.scheduled_for,
      durationMinutes: candidate.duration_minutes,
      enRouteAt: candidate.en_route_at,
      startedAt: candidate.started_at,
      customerConfirmedAt: candidate.customer_confirmed_at ?? null,
    },
    rules.settings,
    nowMs,
  );
  if (!actions.canReschedule) return false;
  const start = Date.parse(gap.startsAt);
  return openSlotsFor(slots, { id: candidate.id, durationMinutes: candidate.duration_minutes, scheduledFor: candidate.scheduled_for }, nowMs, {
    earliestMs: nowMs + rules.leadHours * HOUR,
  }).some((t) => Date.parse(t.startsAt) === start && (!gap.windowKey || t.windowKey === gap.windowKey));
}

async function loadBooking(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">, id: string): Promise<BookingRow | null> {
  const { data } = await (admin as Db)
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", id)
    .maybeSingle();
  return (data as BookingRow | null) ?? null;
}

/** Re-check (on Y, and before a queued offer goes out): candidate unchanged and the page can still take the gap. Null = fine. */
export async function gapOfferStillValid(admin: AdminClient, company: DispatchCompany, gap: Gap, candidate: Pick<GapCandidate, "bookingId" | "startsAt">, nowMs: number): Promise<string | null> {
  const booking = await loadBooking(admin, company, candidate.bookingId);
  if (!booking || (booking.status !== "pending" && booking.status !== "confirmed") || Date.parse(booking.scheduled_for) !== Date.parse(candidate.startsAt)) return "candidate_changed";
  const rules = await loadVisitPageRules(admin, company);
  const slots = await loadSlotContext(admin, company, nowMs);
  return candidateCanTakeGap(rules, slots, gap, booking, nowMs) ? null : "gap_not_offerable";
}

/** SendCheck for queued gap_offer rows. */
export const checkGapOfferStillValid: SendCheck = async (admin, company, row, nowMs) => {
  const gap = asRecord(row.payload?.gap) as unknown as Gap;
  const candidate = asRecord(row.payload?.candidate) as unknown as GapCandidate;
  if (typeof gap.startsAt !== "string" || typeof candidate.bookingId !== "string") return null;
  return gapOfferStillValid(admin, company, gap, candidate, nowMs);
};

// ── Picking a candidate ──────────────────────────────────────────────────────

async function recentlyOffered(admin: AdminClient, company: Pick<DispatchCompany, "companyId">, nowMs: number): Promise<Set<string>> {
  const db = admin as Db;
  const { data } = await db
    .from("dispatch_messages")
    .select("booking_id, status")
    .eq("company_id", company.companyId)
    .eq("kind", "gap_offer")
    .gte("created_at", new Date(nowMs - OFFER_COOLDOWN_MS).toISOString())
    .limit(500);
  const out = new Set(((data ?? []) as Array<{ booking_id: string | null; status: string }>).filter((r) => r.booking_id && r.status !== "skipped").map((r) => r.booking_id as string));
  const { data: pending } = await db.from("owner_approvals").select("payload").eq("company_id", company.companyId).eq("kind", FILL_GAP_KIND).eq("status", "pending").limit(100);
  for (const row of (pending ?? []) as Array<{ payload: unknown }>) {
    const id = asRecord(asRecord(row.payload).candidate).bookingId;
    if (typeof id === "string") out.add(id);
  }
  return out;
}

/** The soonest later booking of a similar length whose visit page can take the gap, or null. */
export async function pickGapCandidate(admin: AdminClient, company: DispatchCompany, gap: Gap, nowMs: number, excludeContactId: string | null, rules: VisitPageRules): Promise<GapCandidate | null> {
  const start = Date.parse(gap.startsAt);
  const slack = Math.max(30, Math.round(gap.durationMinutes * 0.25));
  const { data, error } = await (admin as Db)
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", new Date(start + HOUR).toISOString())
    .lte("scheduled_for", new Date(start + CANDIDATE_HORIZON_MS).toISOString())
    .gte("duration_minutes", Math.max(1, gap.durationMinutes - slack))
    .lte("duration_minutes", gap.durationMinutes + slack)
    .order("scheduled_for", { ascending: true })
    .limit(50);
  if (error) throw error;
  const later = ((data ?? []) as BookingRow[]).filter(
    (b) => b.id !== gap.vacatedBookingId && b.contact_id && b.contact_id !== excludeContactId && !b.en_route_at && !b.started_at && Math.abs(b.duration_minutes - gap.durationMinutes) <= slack,
  );
  if (later.length === 0) return null;
  const offered = await recentlyOffered(admin, company, nowMs);
  const contactIds = [...new Set(later.map((b) => b.contact_id as string))];
  const { data: contactRows } = await (admin as Db)
    .from("contacts")
    .select("id, first_name, last_name, phone, sms_opt_out_at")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("id", contactIds);
  const contacts = new Map(((contactRows ?? []) as Array<Pick<Tables<"contacts">, "id" | "first_name" | "last_name" | "phone" | "sms_opt_out_at">>).map((c) => [c.id, c]));
  const slots = await loadSlotContext(admin, company, nowMs);
  for (const b of later) {
    if (offered.has(b.id)) continue;
    const contact = contacts.get(b.contact_id as string);
    if (!contact?.phone || contact.sms_opt_out_at) continue;
    if (!candidateCanTakeGap(rules, slots, gap, b, nowMs)) continue;
    const who = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || contact.phone;
    return { bookingId: b.id, contactId: contact.id, who, firstName: firstName(contact), job: jobPhrase(b.title), startsAt: b.scheduled_for, durationMinutes: b.duration_minutes };
  }
  return null;
}

// ── Detecting gaps ───────────────────────────────────────────────────────────

interface BookingEvent {
  id: string;
  organization_id: string;
  company_id: string | null;
  entity_id: string | null;
  event_type: string;
  metadata_json: unknown;
  occurred_at?: string;
  created_at?: string;
}

/** PURE: a move that freed a slot, from the event metadata alone (null when it didn't). */
export function vacatedByMove(metadata: unknown): { startsAt: string; durationMinutes: number | null } | null {
  const meta = asRecord(metadata);
  const from = typeof meta.previousScheduledFor === "string" ? meta.previousScheduledFor : null;
  const to = typeof meta.scheduledFor === "string" ? meta.scheduledFor : null;
  if (!from || !to) return null;
  const minutes = typeof meta.durationMinutes === "number" ? meta.durationMinutes : null;
  if (overlaps(Date.parse(from), minutes ?? 60, Date.parse(to), minutes ?? 60)) return null;
  return { startsAt: from, durationMinutes: minutes };
}

async function finishRun(admin: AdminClient, company: DispatchCompany, runKey: string, patch: Record<string, unknown>): Promise<void> {
  await (admin as Db).from("dispatch_runs").update(patch).eq("company_id", company.companyId).eq("kind", "fill_gap").eq("run_key", runKey);
}

function inGapWindow(startMs: number, nowMs: number): boolean {
  return startMs > nowMs + GAP_MIN_LEAD_MS && startMs <= nowMs + GAP_HORIZON_MS;
}

export type GapOutcome = "asked" | "no_gap" | "already" | "no_candidate" | "not_offerable" | "off";

/** One event → maybe one fill_gap approval. The event metadata is checked before any booking is read. */
export async function handleBookingEvent(
  admin: AdminClient,
  company: DispatchCompany,
  event: BookingEvent,
  nowMs: number,
  deps: DispatchApprovalDeps = defaultDispatchApprovalDeps,
): Promise<GapOutcome> {
  if (!company.settings.fillGap.enabled) return "off";
  if (!event.entity_id) return "no_gap";
  const meta = asRecord(event.metadata_json);
  let reason: Gap["reason"];
  let moved: ReturnType<typeof vacatedByMove> = null;
  if (event.event_type === "booking.status_changed") {
    if (meta.status !== "cancelled" || meta.previousStatus === "cancelled") return "no_gap";
    reason = "cancelled";
  } else if (event.event_type === "booking.rescheduled") {
    moved = vacatedByMove(meta);
    if (!moved || !inGapWindow(Date.parse(moved.startsAt), nowMs)) return "no_gap";
    reason = "moved";
  } else {
    return "no_gap";
  }

  const booking = await loadBooking(admin, company, event.entity_id);
  if (!booking) return "no_gap";
  const startsAt = moved ? moved.startsAt : booking.scheduled_for;
  const start = Date.parse(startsAt);
  if (!inGapWindow(start, nowMs)) return "no_gap";

  const db = admin as Db;
  const runKey = gapRunKey(booking.id, startsAt);
  const { error: claimError } = await db
    .from("dispatch_runs")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, kind: "fill_gap", run_key: runKey, status: "running", detail: { eventId: event.id } });
  if (claimError) {
    if ((claimError as { code?: string }).code === "23505") return "already";
    throw claimError;
  }
  try {
    const rules = await loadVisitPageRules(admin, company);
    if (!gapBeyondCutoff(rules, startsAt, nowMs)) {
      await finishRun(admin, company, runKey, { status: "skipped", detail: { reason: rules.allowReschedule ? "inside_change_cutoff" : "self_reschedule_off" } });
      return "not_offerable";
    }
    const { data: contactData } = booking.contact_id
      ? await db.from("contacts").select("id, first_name, last_name, phone").eq("organization_id", company.organizationId).eq("company_id", company.companyId).eq("id", booking.contact_id).maybeSingle()
      : { data: null };
    const c = contactData as Pick<Tables<"contacts">, "first_name" | "last_name" | "phone"> | null;
    const gap: Gap = {
      vacatedBookingId: booking.id,
      startsAt: new Date(start).toISOString(),
      durationMinutes: moved?.durationMinutes ?? booking.duration_minutes,
      windowKey: booking.window_key,
      reason,
      who: (c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.phone : null) || "A customer",
    };
    const candidate = await pickGapCandidate(admin, company, gap, nowMs, booking.contact_id, rules);
    if (!candidate) {
      await finishRun(admin, company, runKey, { status: "skipped", detail: { reason: "no_candidate" } });
      return "no_candidate";
    }
    const approval = await createDispatchApproval(
      admin,
      {
        organizationId: company.organizationId,
        companyId: company.companyId,
        contactId: candidate.contactId,
        kind: FILL_GAP_KIND,
        summary: gapSummary(gap, candidate, company.businessName, company.timeZone, nowMs),
        payload: { gap, candidate },
        // The offer must be answerable while the visit page can still take the gap.
        expiresAt: new Date(Math.max(nowMs + 30 * 60_000, Math.min(start - Math.max(2, rules.leadHours) * HOUR, nowMs + 12 * HOUR))),
      },
      deps,
    );
    await finishRun(admin, company, runKey, { status: "done", approval_id: approval.id });
    return "asked";
  } catch (err) {
    await finishRun(admin, company, runKey, { status: "failed", detail: { reason: err instanceof Error ? err.message.slice(0, 300) : "error" } });
    throw err;
  }
}

/** Event ids this process already handled (the dispatch_runs claim is the real guard). */
const seen = new Set<string>();
function remember(id: string): void {
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value as string);
}

/** Test hook. */
export function resetGapEventMemory(): void {
  seen.clear();
}

/**
 * Scheduler pass: the last 3 hours' cancellations and moves of companies with the switch on,
 * filtered server-side (their organizations, the two event types, cancellations only for
 * status changes), newest first.
 */
export async function sweepFillGap(admin: AdminClient, nowMs: number, companies: Map<string, DispatchCompany>, deps?: DispatchApprovalDeps): Promise<void> {
  const enabled = [...companies.values()].filter((c) => c.settings.fillGap.enabled);
  if (enabled.length === 0) return;
  const orgIds = [...new Set(enabled.map((c) => c.organizationId))];
  const since = new Date(nowMs - GAP_LOOKBACK_MS).toISOString();
  const db = admin as Db;
  const events: BookingEvent[] = [];
  for (let i = 0; i < orgIds.length; i += 150) {
    const chunk = orgIds.slice(i, i + 150);
    const base = (eventType: string) =>
      db
        .from("activity_events")
        .select("id, organization_id, company_id, entity_id, event_type, metadata_json, occurred_at")
        .in("organization_id", chunk)
        .eq("event_type", eventType)
        .gte("occurred_at", since);
    const [cancelled, rescheduled] = await Promise.all([
      base("booking.status_changed").eq("metadata_json->>status", "cancelled").order("occurred_at", { ascending: false }).limit(EVENTS_PER_QUERY),
      base("booking.rescheduled").order("occurred_at", { ascending: false }).limit(EVENTS_PER_QUERY),
    ]);
    if (cancelled.error) throw cancelled.error;
    if (rescheduled.error) throw rescheduled.error;
    events.push(...((cancelled.data ?? []) as BookingEvent[]), ...((rescheduled.data ?? []) as BookingEvent[]));
  }
  for (const event of events) {
    if (seen.has(event.id)) continue;
    const company = event.company_id ? companies.get(event.company_id) : undefined;
    if (!company || company.organizationId !== event.organization_id || !company.settings.fillGap.enabled) continue;
    try {
      await handleBookingEvent(admin, company, event, nowMs, deps);
      remember(event.id);
    } catch (err) {
      console.error("[dispatcher] fill-gap failed", event.entity_id, err instanceof Error ? err.message : err);
    }
  }
}

// ── Executor ─────────────────────────────────────────────────────────────────

/** fill_gap executor: Y → text the candidate the offer (queued until customer hours). */
export async function executeFillGap(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, nowMs = Date.now()): Promise<ExecuteResult> {
  if (!decision.approved) return { ok: true, message: decision.decidedVia === "expiry" ? "That gap offer expired - nothing was sent." : "OK, not offered." };
  if (decision.ownerNote?.trim()) return { ok: false, message: `Nothing sent - #${approval.short_code ?? "?"} doesn't take an amount.` };
  const company = await loadDispatchCompany(admin, approval.organization_id, approval.company_id);
  if (!company) return { ok: false, message: "I couldn't find that business." };
  const gap = asRecord(approval.payload.gap) as unknown as Gap;
  const candidate = asRecord(approval.payload.candidate) as unknown as GapCandidate;
  if (typeof gap.startsAt !== "string" || typeof candidate.bookingId !== "string") return { ok: false, message: "That offer is missing its details." };
  const when = shortLabel(gap.startsAt, company.timeZone, nowMs);
  const why = await gapOfferStillValid(admin, company, gap, candidate, nowMs);
  if (why === "candidate_changed") return { ok: false, message: `${candidate.who}'s booking changed since - nothing sent.` };
  if (why) return { ok: false, message: `${when} can't be offered any more (it's booked, or too close to change online) - nothing sent.` };

  const booking = await loadBooking(admin, company, candidate.bookingId);
  const body = gapOfferText({ businessName: company.businessName, candidate, gapStartsAt: gap.startsAt, timeZone: company.timeZone, link: manageUrl(company, booking?.manage_token) });
  const rules = await loadVisitPageRules(admin, company);
  const outcome = await sendOrQueue(
    admin,
    company,
    {
      kind: "gap_offer",
      dedupeKey: approval.id,
      to: null,
      body,
      audience: "customer",
      consent: true,
      bookingId: candidate.bookingId,
      contactId: booking?.contact_id ?? candidate.contactId,
      approvalId: approval.id,
      // Useless once the visit page can't take the gap any more.
      expiresAt: new Date(Date.parse(gap.startsAt) - rules.leadHours * HOUR),
      payload: { gap, candidate: { bookingId: candidate.bookingId, startsAt: candidate.startsAt } },
    },
    nowMs,
  );
  switch (outcome) {
    case "sent":
    case "duplicate":
      return { ok: true, message: `Offered ${when} to ${candidate.who}. If they take it, it shows up on your calendar.` };
    case "queued":
      return { ok: true, message: `Offering ${when} to ${candidate.who} - the text goes out at ${sentence(timeLabel(new Date(nextSendMs(company, "customer", "gap_offer", nowMs)), company.timeZone))}` };
    case "blocked":
      return { ok: false, message: `Couldn't text ${candidate.who} (they've opted out or haven't agreed to texts).` };
    case "skipped":
      return { ok: false, message: `Too late to offer ${when} - nothing sent.` };
    default:
      return { ok: false, message: `The text to ${candidate.who} didn't go through - I'll retry.` };
  }
}
