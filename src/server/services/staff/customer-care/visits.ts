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
import { markOwnerTakeover } from "@/server/services/sms-agent/takeover";
import { emitActivityEventAndDispatch } from "@/server/services/workflow-engine/dispatch";
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import type { CareCaseRow, CareContact, Db, OfferedSlot, VisitKind } from "./db-types";
import { appendNote } from "./cases";
import { careDeps, loadContact, queueAndSend, tenant } from "./outbox";
import { textOwner } from "./owner";
import type { CareCompany } from "./settings";
import { bookedOwnerLine, customerName, firstNameOf, noTimesText, plain, visitOfferText } from "./texts";
import { nextOpeningLabel } from "./time";

export const SOURCE = "customer_care";
const OFFER_COUNT = 3;

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
export async function offeredCaseFor(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string): Promise<CareCaseRow | null> {
  const { data, error } = await (admin as Db)
    .from("care_cases")
    .select("*")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .eq("visit_stage", "offered")
    .order("offered_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as CareCaseRow[])[0] ?? null;
}

export interface VisitChoice {
  date: string | null;
  window: string | null;
  startsAt: string | null;
}

export type BookVisitResult =
  | { ok: true; bookingId: string; label: string; kind: VisitKind; duplicate: boolean }
  | { ok: false; reason: "no_offer" | "not_open" | "busy" | "error"; alternatives?: OfferedSlot[] };

function sameSlot(slot: OpenSlot | OfferedSlot, choice: VisitChoice): boolean {
  if (choice.startsAt && slot.startsAt) return Date.parse(slot.startsAt) === Date.parse(choice.startsAt);
  return Boolean(choice.date && slot.date === choice.date && (slot.window ?? null) === (choice.window ?? null));
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
  const caseRow = await offeredCaseFor(admin, scope, contact.id);
  if (!caseRow || !caseRow.visit_kind) {
    // Already booked (a repeated tool call)? Report it instead of booking twice.
    const { data: booked } = await db
      .from("care_cases")
      .select("id, visit_kind")
      .eq("organization_id", scope.organizationId)
      .eq("company_id", scope.companyId)
      .eq("contact_id", contact.id)
      .eq("visit_stage", "booked")
      .eq("status", "scheduled")
      .limit(1);
    const recent = ((booked ?? []) as Array<{ id: string; visit_kind: VisitKind }>)[0];
    if (recent) {
      const { data: links } = await db.from("care_case_bookings").select("booking_id").eq("case_id", recent.id).limit(1);
      const link = ((links ?? []) as Array<{ booking_id: string }>)[0];
      if (link) return { ok: true, bookingId: link.booking_id, label: "the time already booked", kind: recent.visit_kind, duplicate: true };
    }
    return { ok: false, reason: "no_offer" };
  }
  const kind = caseRow.visit_kind;
  const { data: claimed } = await db.from("care_cases").update({ visit_stage: "booking" }).eq("id", caseRow.id).eq("organization_id", scope.organizationId).eq("visit_stage", "offered").select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return { ok: false, reason: "busy" };
  const release = async (slots?: OfferedSlot[]) => {
    await db
      .from("care_cases")
      .update({ visit_stage: "offered", ...(slots && slots.length ? { offered_slots: slots } : {}) })
      .eq("id", caseRow.id)
      .eq("organization_id", scope.organizationId)
      .eq("visit_stage", "booking");
  };
  try {
    const result = await visitDeps.availability(admin, facts, { preferredDate: choice.date, preferredWindow: choice.window, limit: 40 });
    const open = result.ok ? result.slots : [];
    const slot = open.find((s) => sameSlot(s, choice));
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
    const { error: linkError } = await db.from("care_case_bookings").insert({ organization_id: scope.organizationId, company_id: scope.companyId, case_id: caseRow.id, booking_id: booking.id, kind });
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
export async function hasOfferedVisit(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string): Promise<boolean> {
  return Boolean(await offeredCaseFor(admin, scope, contactId).catch(() => null));
}

export { loadContact };
