/**
 * Callback and warranty visits. After the owner's Y the customer is texted 2–3 open times from the
 * business's own calendar (the SMS agent's availability: booking windows, or hourly online-booking
 * times — `defaultAgentServices.checkAvailability`, the same core as the phone and check_availability).
 * The customer answers the assistant, which books the one they pick with `book_care_visit`:
 * re-checked open, then a NEW booking ("Callback: …" / "Warranty visit: …", pending, source
 * 'customer_care') linked to its case through care_case_bookings — so invoices/auto.ts never
 * invoices it. No times (no online booking, a full calendar) → the customer is told the owner will
 * call to set a time, and the conversation is the owner's.
 */
import type { Tables } from "@/server/db/database.types";
import { zonedInstant } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { loadBusinessFacts, type BusinessFacts } from "@/server/services/sms-agent/facts";
import { defaultAgentServices, type AvailabilityResult, type OpenSlot } from "@/server/services/sms-agent/services";
import { effectiveState, findConversation } from "@/server/services/sms-agent/conversation";
import { smsAgentLimits } from "@/server/services/sms-agent/settings";
import { markOwnerTakeover } from "@/server/services/sms-agent/takeover";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import type { CareCaseRow, CareContact, Db, OfferedSlot, VisitKind } from "./db-types";
import { appendNote } from "./cases";
import { careDeps, loadContact, queueAndSend, tenant } from "./outbox";
import { textOwner } from "./owner";
import type { CareCompany } from "./settings";
import { bookedOwnerLine, customerName, firstNameOf, noTimesText, plain, visitOfferText } from "./texts";
import { inOwnerWindow, nextOpeningLabel } from "./time";
import { shortWhen } from "@/server/services/owner-channel/common";

export const SOURCE = "customer_care";
const OFFER_COUNT = 3;
/** A visit offer the customer hasn't answered in this long is handed to the owner (outbox sweep). */
export const OFFER_TTL_MS = 14 * 86_400_000;
/** A repeated book_care_visit call within this long reports the booking it already made. */
const REPEAT_WINDOW_MS = 10 * 60_000;

export interface VisitDeps {
  loadFacts(admin: AdminClient, companyId: string): Promise<BusinessFacts>;
  availability(admin: AdminClient, facts: BusinessFacts, input: { preferredDate?: string | null; preferredWindow?: string | null; limit?: number }): Promise<AvailabilityResult>;
}

export const defaultVisitDeps: VisitDeps = {
  loadFacts: (admin, companyId) => loadBusinessFacts(admin, companyId),
  availability: (admin, facts, input) => defaultAgentServices.checkAvailability(admin, facts, input),
};

let visitDeps: VisitDeps = defaultVisitDeps;

/** Test hook. */
export function setVisitDeps(next: Partial<VisitDeps>): void {
  visitDeps = { ...defaultVisitDeps, ...next };
}

export function resetVisitDeps(): void {
  visitDeps = defaultVisitDeps;
}

function toOffered(s: OpenSlot): OfferedSlot {
  return { date: s.date, window: s.window, startsAt: s.startsAt, label: s.label };
}

function phoneOf(contact: CareContact | null): string {
  return (contact?.phone ? prettyPhone(contact.phone) : null) ?? "no number on file";
}

/**
 * The owner said Y to a visit: text the customer 2–3 open times (or "Mike will call you to set a
 * time" when there are none). Returns the owner's one-line reply.
 */
export async function offerVisit(admin: AdminClient, company: CareCompany, caseRow: CareCaseRow, kind: VisitKind, nowMs: number): Promise<{ ok: boolean; message: string }> {
  const db = admin as Db;
  const contact = await loadContact(admin, company.organizationId, caseRow.contact_id);
  const name = customerName(contact);
  if (!contact?.phone) {
    await db.from("care_cases").update({ visit_kind: kind, visit_stage: "owner_calls" }).eq("id", caseRow.id).eq("organization_id", company.organizationId);
    return { ok: false, message: `${name} has no cell on file, so I couldn't text them times. Give them a call to set the visit.` };
  }
  if (contact.sms_opt_out_at) {
    await db.from("care_cases").update({ visit_kind: kind, visit_stage: "owner_calls" }).eq("id", caseRow.id).eq("organization_id", company.organizationId);
    return { ok: false, message: `${name} opted out of texts, so I couldn't text them times. Call them at ${phoneOf(contact)} to set the visit.` };
  }
  // The owner has this conversation (takeover / paused): the assistant must not jump in with times.
  const conv = await findConversation(admin, { companyId: company.companyId, contactId: contact.id }).catch(() => null);
  const state = conv ? effectiveState(conv, new Date(nowMs), smsAgentLimits().takeoverMs) : "ai";
  if (state === "owner" || state === "paused") {
    await db.from("care_cases").update({ visit_kind: kind, visit_stage: "owner_calls" }).eq("id", caseRow.id).eq("organization_id", company.organizationId);
    return { ok: true, message: `You're handling ${name}'s texts right now, so I didn't text them times. Call them at ${phoneOf(contact)} to set the visit.` };
  }
  if (!(await careDeps().smsFrom(tenant(admin, company.organizationId), company.companyId))) {
    await db.from("care_cases").update({ visit_kind: kind, visit_stage: "owner_calls" }).eq("id", caseRow.id).eq("organization_id", company.organizationId);
    return { ok: false, message: `Your business has no texting number of its own yet, so I couldn't text ${name}. Call them at ${phoneOf(contact)} to set the visit.` };
  }
  let facts: BusinessFacts | null = null;
  let slots: OfferedSlot[] = [];
  try {
    facts = await visitDeps.loadFacts(admin, company.companyId);
    const result = await visitDeps.availability(admin, facts, { limit: OFFER_COUNT });
    if (result.ok) slots = result.slots.slice(0, OFFER_COUNT).map(toOffered);
  } catch (err) {
    console.error("[customer-care] availability failed:", err instanceof Error ? err.message : err);
  }
  const owner = facts?.ownerFirstName ?? null;
  const first = firstNameOf(contact);
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const nowIso = new Date(nowMs).toISOString();
  if (slots.length === 0) {
    await db.from("care_cases").update({ visit_kind: kind, visit_stage: "owner_calls", notes: appendNote(caseRow.notes, `No open times to offer (${nowIso.slice(0, 10)}).`) }).eq("id", caseRow.id).eq("organization_id", company.organizationId);
    const outcome = await queueAndSend(admin, { scope, timeZone: company.timeZone, caseId: caseRow.id, contactId: contact.id, kind: "no_times", dedupeKey: caseRow.id, body: noTimesText(company.name, first, owner, caseRow.job_label), nowMs });
    await markOwnerTakeover(admin, { companyId: company.companyId, contactId: contact.id, at: new Date(nowMs) });
    const when = outcome === "queued" ? ` (the text goes at ${nextOpeningLabel(nowMs, company.timeZone)})` : "";
    return { ok: true, message: `No open times on your calendar, so I told ${name} you'll call to set a time${when}. Their number: ${phoneOf(contact)}.` };
  }
  await db
    .from("care_cases")
    .update({ visit_kind: kind, visit_stage: "offered", offered_slots: slots, offered_at: nowIso })
    .eq("id", caseRow.id)
    .eq("organization_id", company.organizationId);
  const outcome = await queueAndSend(admin, {
    scope,
    timeZone: company.timeZone,
    caseId: caseRow.id,
    contactId: contact.id,
    kind: "visit_offer",
    dedupeKey: caseRow.id,
    body: visitOfferText(company.name, first, owner, caseRow.job_label, kind, slots),
    nowMs,
  });
  const visit = kind === "warranty" ? "no-charge warranty visit" : "callback visit";
  const times = slots.map((s) => s.label).join("; ");
  if (outcome === "queued") return { ok: true, message: `It's late, so I'll text ${name} times for a ${visit} at ${nextOpeningLabel(nowMs, company.timeZone)}: ${times}. I'll book the one they pick.` };
  if (outcome === "sent" || outcome === "duplicate") return { ok: true, message: `Texted ${name} times for a ${visit}: ${times}. I'll book the one they pick.` };
  await db.from("care_cases").update({ visit_stage: "owner_calls" }).eq("id", caseRow.id).eq("organization_id", company.organizationId);
  return { ok: false, message: `I couldn't text ${name} (${outcome}). Call them at ${phoneOf(contact)} to set the visit.` };
}

/** The case waiting on this customer's pick, newest first. */
export async function offeredCaseFor(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string, nowMs: number): Promise<CareCaseRow | null> {
  const { data, error } = await (admin as Db)
    .from("care_cases")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .eq("visit_stage", "offered")
    .gte("offered_at", new Date(nowMs - OFFER_TTL_MS).toISOString())
    .order("offered_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as CareCaseRow[])[0] ?? null;
}

export interface VisitChoice {
  /** 1-based position of the time in the offer, as it was listed to the customer. */
  pick?: number | null;
  date: string | null;
  window: string | null;
  startsAt: string | null;
  label?: string | null;
}

export type BookVisitResult =
  | { ok: true; bookingId: string; label: string; kind: VisitKind; duplicate: boolean }
  | { ok: false; reason: "no_offer" | "not_open" | "busy" | "error" | "which_one"; alternatives?: OfferedSlot[] };

/**
 * An ISO time in ms. A time without an offset ("2026-10-14T14:00") is read as the company's local
 * wall-clock time, never the server's. PURE.
 */
export function normalizeStartsAt(value: string | null | undefined, timeZone: string): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  const ms = zonedInstant(m[1], `${m[2]}:${m[3]}`, timeZone).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which of the OFFERED times the customer picked: by its position, its exact start, its label, or
 * (booking windows) its date + window. A bare date in hourly mode only counts when exactly one
 * offered time is on that day. Null → ask which one. PURE.
 */
export function resolveOffered(offered: OfferedSlot[], choice: VisitChoice, timeZone: string): OfferedSlot | null {
  if (offered.length === 0) return null;
  if (choice.pick != null) return Number.isInteger(choice.pick) && choice.pick >= 1 && choice.pick <= offered.length ? offered[choice.pick - 1] : null;
  if (choice.startsAt) {
    const ms = normalizeStartsAt(choice.startsAt, timeZone);
    if (ms == null) return null;
    return offered.find((o) => o.startsAt != null && Date.parse(o.startsAt) === ms) ?? null;
  }
  if (choice.label) {
    const hit = offered.filter((o) => norm(o.label) === norm(choice.label as string));
    if (hit.length === 1) return hit[0];
  }
  if (choice.date && choice.window) return offered.find((o) => o.date === choice.date && o.window === choice.window) ?? null;
  if (choice.date) {
    const sameDay = offered.filter((o) => o.date === choice.date);
    return sameDay.length === 1 ? sameDay[0] : null;
  }
  return null;
}

function sameSlot(open: OpenSlot, offered: OfferedSlot): boolean {
  if (offered.startsAt) return open.startsAt != null && Date.parse(open.startsAt) === Date.parse(offered.startsAt);
  return open.date === offered.date && (open.window ?? null) === (offered.window ?? null);
}

/** Start + length of an open slot: a booking window's start in the company's zone, or the hourly start. */
function slotTiming(facts: BusinessFacts, slot: OpenSlot): { startsAt: string; minutes: number; windowKey: string | null } | null {
  if (slot.window && facts.bookingPolicy) {
    const w = facts.bookingPolicy.windows.find((x) => x.key === slot.window);
    if (!w) return null;
    return { startsAt: zonedInstant(slot.date, w.start, facts.timeZone).toISOString(), minutes: w.durationMinutes, windowKey: w.key };
  }
  if (!slot.startsAt) return null;
  return { startsAt: slot.startsAt, minutes: facts.onlineBooking.slotMinutes ?? 60, windowKey: null };
}

/**
 * Book the time the customer picked for their care visit (the SMS agent's book_care_visit). The
 * case is claimed offered → booking before anything is written; the time is re-checked against the
 * calendar right then. Not open → the case goes back to "offered" with fresh alternatives.
 */
export async function bookCareVisit(admin: AdminClient, company: CareCompany, facts: BusinessFacts, contact: CareContact, choice: VisitChoice, nowMs: number): Promise<BookVisitResult> {
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const db = admin as Db;
  const caseRow = await offeredCaseFor(admin, scope, contact.id, nowMs);
  if (!caseRow || !caseRow.visit_kind) {
    // Booked a few minutes ago (a repeated tool call)? Report it instead of booking twice.
    const { data: booked } = await db
      .from("care_cases")
      .select("id, visit_kind")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("contact_id", contact.id)
      .eq("visit_stage", "booked")
      .eq("status", "scheduled")
      .limit(20);
    const cases = (booked ?? []) as Array<{ id: string; visit_kind: VisitKind }>;
    if (cases.length) {
      const { data: links } = await db
        .from("care_case_bookings")
        .select("booking_id, case_id, created_at")
        .eq("organization_id", scope.organizationId)
        .in("case_id", cases.map((c) => c.id))
        .gte("created_at", new Date(nowMs - REPEAT_WINDOW_MS).toISOString())
        .limit(1);
      const link = ((links ?? []) as Array<{ booking_id: string; case_id: string }>)[0];
      const kind = cases.find((c) => c.id === link?.case_id)?.visit_kind;
      if (link && kind) return { ok: true, bookingId: link.booking_id, label: "the time already booked", kind, duplicate: true };
    }
    return { ok: false, reason: "no_offer" };
  }
  const kind = caseRow.visit_kind;
  const offered = (Array.isArray(caseRow.offered_slots) ? caseRow.offered_slots : []) as OfferedSlot[];
  const picked = resolveOffered(offered, choice, company.timeZone);
  if (!picked) return { ok: false, reason: "which_one", alternatives: offered };
  const { data: claimed } = await db.from("care_cases").update({ visit_stage: "booking" }).eq("id", caseRow.id).eq("organization_id", scope.organizationId).eq("visit_stage", "offered").select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return { ok: false, reason: "busy" };
  const release = async (slots?: OfferedSlot[]) => {
    await db
      .from("care_cases")
      .update({ visit_stage: "offered", ...(slots && slots.length ? { offered_slots: slots, offered_at: new Date(nowMs).toISOString() } : {}) })
      .eq("id", caseRow.id)
      .eq("organization_id", scope.organizationId)
      .eq("visit_stage", "booking");
  };
  try {
    const result = await visitDeps.availability(admin, facts, { preferredDate: picked.date, preferredWindow: picked.window, limit: 40 });
    const open = result.ok ? result.slots : [];
    const slot = open.find((s) => sameSlot(s, picked));
    if (!slot) {
      const alternatives = open.slice(0, OFFER_COUNT).map(toOffered);
      await release(alternatives);
      return { ok: false, reason: "not_open", alternatives };
    }
    const timing = slotTiming(facts, slot);
    if (!timing) {
      await release();
      return { ok: false, reason: "not_open", alternatives: open.slice(0, OFFER_COUNT).map(toOffered) };
    }
    const name = customerName(contact);
    const what = caseRow.job_label ? plain(caseRow.job_label, 60) : "job";
    const title = `${kind === "warranty" ? "Warranty visit" : "Callback"}: ${what.charAt(0).toUpperCase()}${what.slice(1)} (${name})`.slice(0, 200);
    const { data: bookingData, error: bookingError } = await db
      .from("bookings")
      .insert({
        organization_id: scope.organizationId,
        company_id: scope.companyId,
        contact_id: contact.id,
        created_by: null,
        title,
        description: [
          kind === "warranty" ? "No-charge warranty visit (the owner OK'd it by text)." : "Callback visit for a customer care case (the owner OK'd it by text).",
          "Not invoiced automatically.",
          caseRow.summary ? `Customer said: ${plain(caseRow.summary, 300)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        duration_minutes: timing.minutes,
        scheduled_for: timing.startsAt,
        window_key: timing.windowKey,
        status: "pending",
        source: SOURCE,
      })
      .select("*")
      .single();
    if (bookingError) throw bookingError;
    const booking = bookingData as Tables<"bookings">;
    const { error: linkError } = await db.from("care_case_bookings").insert({ organization_id: scope.organizationId, company_id: scope.companyId, case_id: caseRow.id, booking_id: booking.id, kind, created_at: new Date(nowMs).toISOString() });
    if (linkError) {
      // Never leave an unlinked (invoiceable) visit behind.
      await db.from("bookings").update({ status: "cancelled" }).eq("id", booking.id).eq("organization_id", scope.organizationId);
      throw linkError;
    }
    await db
      .from("care_cases")
      .update({ status: "scheduled", visit_stage: "booked", notes: appendNote(caseRow.notes, `${kind === "warranty" ? "Warranty" : "Callback"} visit booked: ${slot.label}.`) })
      .eq("id", caseRow.id)
      .eq("organization_id", scope.organizationId);
    try {
      await emitActivityEventAndDispatch(tenant(admin, scope.organizationId), {
        companyId: scope.companyId,
        entityId: booking.id,
        entityType: "booking",
        eventType: "booking.created",
        metadata: { bookingId: booking.id, scheduledFor: booking.scheduled_for, status: booking.status, source: SOURCE },
        relatedEntityId: contact.id,
        relatedEntityType: "contact",
      });
    } catch (err) {
      console.error("[customer-care] booking.created dispatch failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await textOwner(admin, company, bookedOwnerLine(name, kind, slot.label), nowMs);
    return { ok: true, bookingId: booking.id, label: slot.label, kind, duplicate: false };
  } catch (err) {
    console.error("[customer-care] booking the care visit failed:", err instanceof Error ? err.message : err);
    await release();
    return { ok: false, reason: "error" };
  }
}

/** Is this contact a care-visit customer whose pick is awaited? (For tool gating.) */
export async function hasOfferedVisit(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string, nowMs: number): Promise<boolean> {
  return Boolean(await offeredCaseFor(admin, scope, contactId, nowMs).catch(() => null));
}

export { loadContact };

/**
 * A callback / warranty visit was cancelled (from the app, the owner by text, the visit page): if the
 * case has no other visit still on, it goes back to open — out of the way of the customer's next
 * claim or check-in — and the owner is told (08:00–21:00; outside that the sweep waits, the event
 * stays in its 3-day look-back). Conditional on the case still being `scheduled`, so once only.
 */
export async function reopenCancelledVisits(admin: AdminClient, company: CareCompany, bookingIds: string[], nowMs: number): Promise<number> {
  if (bookingIds.length === 0 || !inOwnerWindow(nowMs, company.timeZone)) return 0;
  const db = admin as Db;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const { data: links, error } = await db.from("care_case_bookings").select("booking_id, case_id, kind").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("booking_id", bookingIds.slice(0, 500));
  if (error) throw error;
  let reopened = 0;
  for (const link of (links ?? []) as Array<{ booking_id: string; case_id: string; kind: VisitKind }>) {
    const caseRow = await loadCaseRow(admin, scope, link.case_id);
    if (!caseRow || caseRow.status !== "scheduled") continue;
    const { data: siblings } = await db.from("care_case_bookings").select("booking_id").eq("organization_id", scope.organizationId).eq("case_id", caseRow.id);
    const otherIds = ((siblings ?? []) as Array<{ booking_id: string }>).map((r) => r.booking_id).filter((id) => id !== link.booking_id);
    if (otherIds.length) {
      const { data: live } = await db.from("bookings").select("id").eq("organization_id", scope.organizationId).in("id", otherIds).in("status", ["pending", "confirmed"]).limit(1);
      if (((live ?? []) as unknown[]).length) continue;
    }
    const { data: b } = await db.from("bookings").select("scheduled_for, status").eq("organization_id", scope.organizationId).eq("id", link.booking_id).maybeSingle();
    const visit = b as { scheduled_for: string; status: string } | null;
    if (visit && visit.status !== "cancelled") continue;
    const { data: claimed } = await db
      .from("care_cases")
      .update({ status: "open", visit_stage: "owner_calls", notes: appendNote(caseRow.notes, "The visit was cancelled - case open again.") })
      .eq("id", caseRow.id)
      .eq("organization_id", scope.organizationId)
      .eq("status", "scheduled")
      .select("id");
    if (((claimed ?? []) as unknown[]).length === 0) continue;
    reopened++;
    const contact = await loadContact(admin, scope.organizationId, caseRow.contact_id).catch(() => null);
    const when = visit ? ` (${shortWhen(visit.scheduled_for, company.timeZone)})` : "";
    await textOwner(admin, company, `${customerName(contact)}'s ${link.kind === "warranty" ? "warranty" : "callback"} visit${when} was cancelled, so their case is open again. Call them at ${phoneOf(contact)} to set a new time.`, nowMs);
  }
  return reopened;
}

async function loadCaseRow(admin: AdminClient, scope: { organizationId: string; companyId: string }, caseId: string): Promise<CareCaseRow | null> {
  const { data } = await (admin as Db).from("care_cases").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", caseId).maybeSingle();
  return (data as CareCaseRow | null) ?? null;
}

/**
 * Housekeeping (outbox sweep): an offer nobody answered in 14 days goes to the owner; a `booking`
 * claim left by a crashed worker (10 minutes) goes back to `offered`.
 */
export async function tidyOffers(admin: AdminClient, companies: CareCompany[], nowMs: number): Promise<void> {
  const db = admin as Db;
  const byId = new Map(companies.map((c) => [c.companyId, c]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    await db.from("care_cases").update({ visit_stage: "offered" }).eq("visit_stage", "booking").in("company_id", part).lt("updated_at", new Date(nowMs - 10 * 60_000).toISOString());
    const { data, error } = await db.from("care_cases").select("*").eq("status", "open").eq("visit_stage", "offered").in("company_id", part).lt("offered_at", new Date(nowMs - OFFER_TTL_MS).toISOString()).limit(200);
    if (error) throw error;
    for (const c of (data ?? []) as CareCaseRow[]) {
      const company = byId.get(c.company_id);
      if (!company || company.organizationId !== c.organization_id || !inOwnerWindow(nowMs, company.timeZone)) continue;
      const { data: claimed } = await db.from("care_cases").update({ visit_stage: "owner_calls" }).eq("id", c.id).eq("visit_stage", "offered").select("id");
      if (((claimed ?? []) as unknown[]).length === 0) continue;
      const contact = await loadContact(admin, c.organization_id, c.contact_id).catch(() => null);
      await textOwner(admin, company, `${customerName(contact)} never picked a time for the ${c.visit_kind === "warranty" ? "warranty" : "callback"} visit (offered 2 weeks ago). Give them a call at ${phoneOf(contact)}.`, nowMs);
    }
  }
}
