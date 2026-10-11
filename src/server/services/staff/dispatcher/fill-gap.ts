/**
 * Filling the gap: when a job in the next 48 hours is cancelled or moved away (any path — the
 * app, the owner by text, the customer's own visit page), the owner gets a fill_gap approval:
 * "Sam Lee cancelled Thu 9am. Offer it to Jo Park (booked Fri 2pm)?". On Y, Jo gets a text
 * offering the earlier time with their manage link (they pick it there; nothing moves on its own).
 *
 * The candidate: the soonest LATER booking (within 14 days) of a similar length that fits the
 * gap, whose customer can be texted and hasn't been offered a gap in the last 7 days.
 * Detected from booking.status_changed (→ cancelled) / booking.rescheduled activity events;
 * one claim per vacated slot (dispatch_runs kind fill_gap), so it's asked once. Slots the
 * Dispatcher itself emptied (weather / day moves) are pre-claimed and never offered.
 */
import type { Tables } from "@/server/db/database.types";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { createDispatchApproval, defaultDispatchApprovalDeps, FILL_GAP_KIND, type DispatchApprovalDeps } from "./approvals";
import { loadDispatchCompany, manageUrl, type DispatchCompany } from "./company";
import type { Db } from "./db-types";
import { firstName, greeting, jobPhrase, sendOrQueue } from "./messages";
import { gapRunKey, LINK_PLACEHOLDER } from "./moves";
import { nextLocalTime, sentence, shortLabel, timeLabel, whenLabel } from "./time";

const HOUR = 3_600_000;
export const GAP_HORIZON_MS = 48 * HOUR;
/** Gaps starting sooner than this aren't worth offering. */
export const GAP_MIN_LEAD_MS = 2 * HOUR;
export const GAP_LOOKBACK_MS = 3 * HOUR;
export const OFFER_COOLDOWN_MS = 7 * 86_400_000;
const CANDIDATE_HORIZON_MS = 14 * 86_400_000;

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
export function gapSummary(gap: Gap, candidate: GapCandidate, businessName: string, timeZone: string): string {
  const what = gap.reason === "cancelled" ? `${gap.who} cancelled ${shortLabel(gap.startsAt, timeZone)}.` : `${gap.who} moved off ${shortLabel(gap.startsAt, timeZone)}.`;
  const text = gapOfferText({ businessName, candidate, gapStartsAt: gap.startsAt, timeZone, link: LINK_PLACEHOLDER });
  return `${what} Offer it to ${candidate.who} (booked ${shortLabel(candidate.startsAt, timeZone)})? They'd get: "${text}"`.slice(0, 500);
}

function similarLength(candidate: number, gap: number): boolean {
  return Math.abs(candidate - gap) <= Math.max(30, Math.round(gap * 0.25));
}

function overlaps(aStart: number, aMinutes: number, bStart: number, bMinutes: number): boolean {
  return aStart < bStart + Math.max(1, bMinutes) * 60_000 && bStart < aStart + Math.max(1, aMinutes) * 60_000;
}

type BookingRow = Pick<Tables<"bookings">, "id" | "contact_id" | "title" | "scheduled_for" | "duration_minutes" | "window_key" | "status" | "en_route_at" | "started_at" | "manage_token">;

async function bookingsAround(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">, fromMs: number, toMs: number): Promise<BookingRow[]> {
  const { data, error } = await (admin as Db)
    .from("bookings")
    .select("id, contact_id, title, scheduled_for, duration_minutes, window_key, status, en_route_at, started_at, manage_token")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_for", new Date(fromMs).toISOString())
    .lte("scheduled_for", new Date(toMs).toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(1000);
  if (error) throw error;
  return (data ?? []) as BookingRow[];
}

/** Is the gap still empty (no open booking overlapping it)? Window companies: nothing else booked into that window then. */
export async function gapStillOpen(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">, gap: Gap, ignoreBookingId?: string): Promise<boolean> {
  const start = Date.parse(gap.startsAt);
  const around = await bookingsAround(admin, company, start - 24 * HOUR, start + 24 * HOUR);
  return !around.some((b) => b.id !== ignoreBookingId && b.id !== gap.vacatedBookingId && overlaps(start, gap.durationMinutes, Date.parse(b.scheduled_for), b.duration_minutes));
}

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

/** The soonest later booking that fits the gap and can be offered it, or null. */
export async function pickGapCandidate(admin: AdminClient, company: DispatchCompany, gap: Gap, nowMs: number, excludeContactId: string | null): Promise<GapCandidate | null> {
  const start = Date.parse(gap.startsAt);
  const later = (await bookingsAround(admin, company, start + HOUR, start + CANDIDATE_HORIZON_MS)).filter(
    (b) => b.id !== gap.vacatedBookingId && b.contact_id && b.contact_id !== excludeContactId && !b.en_route_at && !b.started_at && similarLength(b.duration_minutes, gap.durationMinutes),
  );
  if (later.length === 0) return null;
  const offered = await recentlyOffered(admin, company, nowMs);
  const neighbours = await bookingsAround(admin, company, start - 24 * HOUR, start + 24 * HOUR);
  const contactIds = [...new Set(later.map((b) => b.contact_id as string))];
  const { data } = await (admin as Db)
    .from("contacts")
    .select("id, first_name, last_name, phone, sms_opt_out_at")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("id", contactIds);
  const contacts = new Map(((data ?? []) as Array<Pick<Tables<"contacts">, "id" | "first_name" | "last_name" | "phone" | "sms_opt_out_at">>).map((c) => [c.id, c]));
  for (const b of later) {
    if (offered.has(b.id)) continue;
    const contact = contacts.get(b.contact_id as string);
    if (!contact?.phone || contact.sms_opt_out_at) continue;
    // It must fit: placed at the gap with its own length, it overlaps nobody (but itself).
    const clash = neighbours.some((n) => n.id !== b.id && n.id !== gap.vacatedBookingId && overlaps(start, b.duration_minutes, Date.parse(n.scheduled_for), n.duration_minutes));
    if (clash) continue;
    const who = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || contact.phone;
    return { bookingId: b.id, contactId: contact.id, who, firstName: firstName(contact), job: jobPhrase(b.title), startsAt: b.scheduled_for, durationMinutes: b.duration_minutes };
  }
  return null;
}

interface BookingEvent {
  id: string;
  organization_id: string;
  company_id: string | null;
  entity_id: string | null;
  event_type: string;
  metadata_json: unknown;
  created_at: string;
}

/** PURE-ish: what slot an event vacated (null when it didn't free one). */
export function vacatedSlot(event: Pick<BookingEvent, "event_type" | "metadata_json">, booking: Pick<BookingRow, "scheduled_for" | "duration_minutes" | "window_key">): { startsAt: string; durationMinutes: number; windowKey: string | null; reason: Gap["reason"] } | null {
  const meta = asRecord(event.metadata_json);
  if (event.event_type === "booking.status_changed") {
    if (meta.status !== "cancelled" || meta.previousStatus === "cancelled") return null;
    return { startsAt: booking.scheduled_for, durationMinutes: booking.duration_minutes, windowKey: booking.window_key, reason: "cancelled" };
  }
  if (event.event_type === "booking.rescheduled") {
    const from = typeof meta.previousScheduledFor === "string" ? meta.previousScheduledFor : null;
    const to = typeof meta.scheduledFor === "string" ? meta.scheduledFor : null;
    if (!from || !to) return null;
    const minutes = typeof meta.durationMinutes === "number" ? meta.durationMinutes : booking.duration_minutes;
    if (overlaps(Date.parse(from), minutes, Date.parse(to), minutes)) return null;
    return { startsAt: from, durationMinutes: minutes, windowKey: booking.window_key, reason: "moved" };
  }
  return null;
}

async function finishRun(admin: AdminClient, company: DispatchCompany, runKey: string, patch: Record<string, unknown>): Promise<void> {
  await (admin as Db).from("dispatch_runs").update(patch).eq("company_id", company.companyId).eq("kind", "fill_gap").eq("run_key", runKey);
}

/** One event → maybe one fill_gap approval. */
export async function handleBookingEvent(
  admin: AdminClient,
  company: DispatchCompany,
  event: BookingEvent,
  nowMs: number,
  deps: DispatchApprovalDeps = defaultDispatchApprovalDeps,
): Promise<"asked" | "no_gap" | "already" | "no_candidate" | "filled" | "off"> {
  if (!company.settings.fillGap.enabled) return "off";
  if (!event.entity_id) return "no_gap";
  const db = admin as Db;
  const { data } = await db
    .from("bookings")
    .select("id, contact_id, title, scheduled_for, duration_minutes, window_key, status, en_route_at, started_at, manage_token")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", event.entity_id)
    .maybeSingle();
  const booking = data as BookingRow | null;
  if (!booking) return "no_gap";
  const slot = vacatedSlot(event, booking);
  if (!slot) return "no_gap";
  const start = Date.parse(slot.startsAt);
  if (!(start > nowMs + GAP_MIN_LEAD_MS && start <= nowMs + GAP_HORIZON_MS)) return "no_gap";

  const runKey = gapRunKey(booking.id, slot.startsAt);
  const { error: claimError } = await db
    .from("dispatch_runs")
    .insert({ organization_id: company.organizationId, company_id: company.companyId, kind: "fill_gap", run_key: runKey, status: "running", detail: { eventId: event.id } });
  if (claimError) {
    if ((claimError as { code?: string }).code === "23505") return "already";
    throw claimError;
  }
  try {
    const { data: contactData } = booking.contact_id
      ? await db.from("contacts").select("id, first_name, last_name, phone").eq("organization_id", company.organizationId).eq("company_id", company.companyId).eq("id", booking.contact_id).maybeSingle()
      : { data: null };
    const c = contactData as Pick<Tables<"contacts">, "first_name" | "last_name" | "phone"> | null;
    const gap: Gap = {
      vacatedBookingId: booking.id,
      startsAt: new Date(start).toISOString(),
      durationMinutes: slot.durationMinutes,
      windowKey: slot.windowKey,
      reason: slot.reason,
      who: (c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.phone : null) || "A customer",
    };
    if (!(await gapStillOpen(admin, company, gap))) {
      await finishRun(admin, company, runKey, { status: "skipped", detail: { reason: "already_filled" } });
      return "filled";
    }
    const candidate = await pickGapCandidate(admin, company, gap, nowMs, booking.contact_id);
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
        summary: gapSummary(gap, candidate, company.businessName, company.timeZone),
        payload: { gap, candidate },
        expiresAt: new Date(Math.max(nowMs + 30 * 60_000, Math.min(start - 2 * HOUR, nowMs + 12 * HOUR))),
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

/** Scheduler pass: recent cancellations / moves of companies with the setting on. */
export async function sweepFillGap(admin: AdminClient, nowMs: number, companies: Map<string, DispatchCompany>, deps?: DispatchApprovalDeps): Promise<void> {
  if (![...companies.values()].some((c) => c.settings.fillGap.enabled)) return;
  const { data, error } = await (admin as Db)
    .from("activity_events")
    .select("id, organization_id, company_id, entity_id, event_type, metadata_json, created_at")
    .in("event_type", ["booking.status_changed", "booking.rescheduled"])
    .gte("created_at", new Date(nowMs - GAP_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) throw error;
  for (const event of (data ?? []) as BookingEvent[]) {
    const company = event.company_id ? companies.get(event.company_id) : undefined;
    if (!company || company.organizationId !== event.organization_id || !company.settings.fillGap.enabled) continue;
    try {
      await handleBookingEvent(admin, company, event, nowMs, deps);
    } catch (err) {
      console.error("[dispatcher] fill-gap failed", event.entity_id, err instanceof Error ? err.message : err);
    }
  }
}

/** fill_gap executor: Y → text the candidate the offer (queued until customer hours). */
export async function executeFillGap(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, nowMs = Date.now()): Promise<ExecuteResult> {
  if (!decision.approved) return { ok: true, message: decision.decidedVia === "expiry" ? "That gap offer expired - nothing was sent." : "OK, not offered." };
  if (decision.ownerNote?.trim()) return { ok: false, message: `Nothing sent - #${approval.short_code ?? "?"} doesn't take an amount.` };
  const company = await loadDispatchCompany(admin, approval.organization_id, approval.company_id);
  if (!company) return { ok: false, message: "I couldn't find that business." };
  const gap = asRecord(approval.payload.gap) as unknown as Gap;
  const candidate = asRecord(approval.payload.candidate) as unknown as GapCandidate;
  if (typeof gap.startsAt !== "string" || typeof candidate.bookingId !== "string") return { ok: false, message: "That offer is missing its details." };
  const start = Date.parse(gap.startsAt);
  if (start <= nowMs + HOUR) return { ok: false, message: `${shortLabel(gap.startsAt, company.timeZone)} is too soon now - nothing sent.` };

  const { data } = await (admin as Db)
    .from("bookings")
    .select("id, contact_id, title, scheduled_for, duration_minutes, window_key, status, en_route_at, started_at, manage_token")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .eq("id", candidate.bookingId)
    .maybeSingle();
  const booking = data as BookingRow | null;
  if (!booking || (booking.status !== "pending" && booking.status !== "confirmed") || Date.parse(booking.scheduled_for) !== Date.parse(candidate.startsAt)) {
    return { ok: false, message: `${candidate.who}'s booking changed since - nothing sent.` };
  }
  if (!(await gapStillOpen(admin, company, gap, booking.id))) return { ok: false, message: `${shortLabel(gap.startsAt, company.timeZone)} is already booked - nothing sent.` };

  const body = gapOfferText({ businessName: company.businessName, candidate, gapStartsAt: gap.startsAt, timeZone: company.timeZone, link: manageUrl(company, booking.manage_token) });
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
      bookingId: booking.id,
      contactId: booking.contact_id,
      approvalId: approval.id,
      expiresAt: new Date(start - HOUR),
      payload: { gapStartsAt: gap.startsAt },
    },
    nowMs,
  );
  const when = shortLabel(gap.startsAt, company.timeZone);
  switch (outcome) {
    case "sent":
    case "duplicate":
      return { ok: true, message: `Offered ${when} to ${candidate.who}. If they take it, it shows up on your calendar.` };
    case "queued":
      return { ok: true, message: `Offering ${when} to ${candidate.who} - the text goes out at ${timeLabel(nextLocalTime(nowMs, company.timeZone, company.settings.customerHours.from), company.timeZone)}.` };
    case "blocked":
      return { ok: false, message: `Couldn't text ${candidate.who} (they've opted out or haven't agreed to texts).` };
    case "skipped":
      return { ok: false, message: `Too late to offer ${when} before it starts - nothing sent.` };
    default:
      return { ok: false, message: `The text to ${candidate.who} didn't go through - I'll retry.` };
  }
}
