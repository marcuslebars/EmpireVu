/**
 * Care cases: complaints from a check-in answer, warranty claims from the SMS agent, and the owner
 * approvals that decide what happens next.
 *
 *   Low rating / complaint (record_job_feedback) → a `complaint` case + TWO care_followup approvals
 *   (Y <visit code> books a callback visit, Y <call code> texts "Mike will call you today", N to
 *   leave it), told to the owner in ONE text. The approvals are inserted already "notified" to
 *   nobody, so the approvals sweep never texts them one by one; the case's owner alert carries both
 *   codes and, once it went out, stamps both approvals as asked of the owner's phone (so "Y 12"
 *   counts). 08:00–21:00 local; otherwise the alert waits for the outbox sweep.
 *
 *   Problem with past work under warranty (check_warranty) → a `warranty` case + one
 *   warranty_claim approval, texted through notifyOwnerOfApproval (quiet hours respected).
 *
 * Never gates review requests: nothing here reads or writes review_requests.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { insertApproval } from "@/server/services/front-desk/approvals";
import { findOwnerCompanies } from "@/server/services/owner-channel/common";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import type { CareCaseRow, CareContact, Db, InstalledEquipmentRow, JobWarrantyRow } from "./db-types";
import { textOwner } from "./owner";
import type { CareCompany } from "./settings";
import { careFollowupOwnerText, careFollowupSummary, customerName, lowRatingLine, warrantyClaimSummary } from "./texts";
import { expiryInHours } from "./time";

export const CARE_FOLLOWUP_KIND = "care_followup";
export const WARRANTY_CLAIM_KIND = "warranty_claim";
export const CARE_REQUESTED_BY = "customer_care";
/** Both kinds wait two days for the owner (the expiry lands inside 09:00–20:00). */
export const APPROVAL_TTL_MS = 48 * 3_600_000;

type Scope = { organizationId: string; companyId: string };

export async function loadCase(admin: AdminClient, scope: Scope, caseId: string): Promise<CareCaseRow | null> {
  const { data, error } = await (admin as Db).from("care_cases").select("*").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).eq("id", caseId).maybeSingle();
  if (error) throw error;
  return (data as CareCaseRow | null) ?? null;
}

export function appendNote(current: string | null, line: string): string {
  const next = current ? `${current}\n${line}` : line;
  return next.length > 2000 ? next.slice(next.length - 2000) : next;
}

export interface ComplaintInput {
  company: CareCompany;
  contact: CareContact;
  checkinId: string;
  bookingId: string | null;
  jobLabel: string | null;
  rating: number | null;
  comment: string | null;
  ownerFirst: string | null;
  conversationId?: string | null;
  nowMs: number;
}

export type ComplaintResult = { caseRow: CareCaseRow; created: boolean; approvals: Array<{ id: string; shortCode: number | null }> };

/**
 * Open the complaint case for a check-in answer (once per check-in: a second unhappy text is added
 * to the same case's notes, no second alert), ask the owner, and text them now when it's 08:00–21:00.
 */
export async function openComplaint(admin: AdminClient, input: ComplaintInput): Promise<ComplaintResult> {
  const { company } = input;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const db = admin as Db;
  const name = customerName(input.contact);
  const nowIso = new Date(input.nowMs).toISOString();
  const addToExisting = async (row: CareCaseRow): Promise<ComplaintResult> => {
    if (input.comment) {
      await db.from("care_cases").update({ notes: appendNote(row.notes, `Customer added: ${input.comment.slice(0, 300)}`) }).eq("id", row.id).eq("organization_id", scope.organizationId);
    }
    return { caseRow: row, created: false, approvals: [] };
  };
  const { data: prior } = await db.from("care_cases").select("*").eq("organization_id", scope.organizationId).eq("checkin_id", input.checkinId).limit(1);
  const priorRow = ((prior ?? []) as CareCaseRow[])[0];
  if (priorRow) return addToExisting(priorRow);
  const { data: inserted, error } = await db
    .from("care_cases")
    .insert({
      organization_id: scope.organizationId,
      company_id: scope.companyId,
      contact_id: input.contact.id,
      booking_id: input.bookingId,
      job_label: input.jobLabel,
      kind: "complaint",
      status: "open",
      summary: input.comment?.slice(0, 1000) ?? null,
      rating: input.rating,
      opened_via: "checkin",
      checkin_id: input.checkinId,
      owner_alert_status: "none",
      created_at: nowIso,
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const { data: existing, error: e2 } = await db.from("care_cases").select("*").eq("organization_id", scope.organizationId).eq("checkin_id", input.checkinId).maybeSingle();
    if (e2 || !existing) throw e2 ?? error;
    return addToExisting(existing as CareCaseRow);
  }
  const caseRow = inserted as CareCaseRow;

  const alert = lowRatingLine(name, input.jobLabel, input.rating, input.comment);
  const createdAt = new Date(input.nowMs);
  const expiresAt = expiryInHours(input.nowMs, APPROVAL_TTL_MS, company.timeZone);
  const base = {
    caseId: caseRow.id,
    contactId: input.contact.id,
    customerName: name,
    customerFirst: input.contact.first_name ?? null,
    jobLabel: input.jobLabel,
    ownerFirst: input.ownerFirst,
  };
  const approvalIds: string[] = [];
  const asked: Array<{ id: string; shortCode: number | null }> = [];
  let body: string | null = null;
  try {
    // Inserted "notified" to nobody: only the case's own text (with both codes) asks the owner.
    const visit = await insertApproval(admin, {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      contactId: input.contact.id,
      conversationId: input.conversationId ?? null,
      kind: CARE_FOLLOWUP_KIND,
      summary: careFollowupSummary("visit", alert, input.ownerFirst),
      payload: { ...base, option: "visit" },
      requestedBy: CARE_REQUESTED_BY,
      createdAt,
      expiresAt,
      notifiedAt: createdAt,
      notifiedTo: null,
    });
    approvalIds.push(visit.id);
    const call = await insertApproval(admin, {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      contactId: input.contact.id,
      conversationId: input.conversationId ?? null,
      kind: CARE_FOLLOWUP_KIND,
      summary: careFollowupSummary("call", alert, input.ownerFirst),
      payload: { ...base, option: "call", siblingId: visit.id },
      requestedBy: CARE_REQUESTED_BY,
      createdAt,
      expiresAt,
      notifiedAt: createdAt,
      notifiedTo: null,
    });
    approvalIds.push(call.id);
    asked.push({ id: visit.id, shortCode: visit.short_code }, { id: call.id, shortCode: call.short_code });
    await db.from("owner_approvals").update({ payload: { ...base, option: "visit", siblingId: call.id } }).eq("id", visit.id).eq("organization_id", scope.organizationId);
    body = careFollowupOwnerText(alert, visit.short_code, call.short_code, input.ownerFirst);
  } catch (err) {
    console.error("[customer-care] could not create the follow-up approvals:", err instanceof Error ? err.message : err);
    if (approvalIds.length) await db.from("owner_approvals").update({ status: "superseded" }).in("id", approvalIds).eq("status", "pending");
    approvalIds.length = 0;
    asked.length = 0;
  }
  // No approvals (a failure) → a plain heads-up so the owner still hears about it.
  const alertBody = body ?? `${alert} Text them back, or text me "care status".`;
  const { data: updated } = await db
    .from("care_cases")
    .update({ approval_ids: approvalIds, owner_alert_body: alertBody.slice(0, 700), owner_alert_status: "pending" })
    .eq("id", caseRow.id)
    .eq("organization_id", scope.organizationId)
    .select("*");
  const fresh = ((updated ?? []) as CareCaseRow[])[0] ?? { ...caseRow, approval_ids: approvalIds, owner_alert_body: alertBody, owner_alert_status: "pending" as const };
  await sendCaseAlert(admin, company, fresh, input.nowMs);
  return { caseRow: fresh, created: true, approvals: asked };
}

/**
 * Send a case's pending owner alert (08:00–21:00 local, verified cell). Claimed pending → sending;
 * on success both care_followup approvals are stamped as asked of the owner's phone. A held or
 * failed send goes back to pending (the outbox sweep retries); once no approval is pending any
 * more (decided in the app, or expired) the alert is dropped ('none').
 */
export async function sendCaseAlert(admin: AdminClient, company: CareCompany, caseRow: CareCaseRow, nowMs: number): Promise<"sent" | "held" | "dropped"> {
  const db = admin as Db;
  if (caseRow.owner_alert_status !== "pending" || !caseRow.owner_alert_body) return "dropped";
  const ids = caseRow.approval_ids ?? [];
  if (ids.length) {
    const { data: live } = await db.from("owner_approvals").select("id").in("id", ids).eq("status", "pending");
    if (((live ?? []) as unknown[]).length === 0) {
      await db.from("care_cases").update({ owner_alert_status: "none" }).eq("id", caseRow.id).eq("owner_alert_status", "pending");
      return "dropped";
    }
  }
  const { data: claimed } = await db.from("care_cases").update({ owner_alert_status: "sending" }).eq("id", caseRow.id).eq("organization_id", company.organizationId).eq("owner_alert_status", "pending").select("id");
  if (((claimed ?? []) as unknown[]).length === 0) return "held";
  // An owner with several businesses sees which one it's about.
  const owned = company.ownerPhone ? await findOwnerCompanies(admin, company.ownerPhone).catch(() => []) : [];
  const body = owned.length > 1 ? `${company.name}: ${caseRow.owner_alert_body}` : caseRow.owner_alert_body;
  const outcome = await textOwner(admin, company, body, nowMs);
  if (outcome === "blocked") {
    // The owner texted STOP to the platform number: stop retrying (the app's Approvals card still works).
    await db.from("care_cases").update({ owner_alert_status: "none" }).eq("id", caseRow.id).eq("owner_alert_status", "sending");
    return "dropped";
  }
  if (outcome !== "sent") {
    await db.from("care_cases").update({ owner_alert_status: "pending" }).eq("id", caseRow.id).eq("owner_alert_status", "sending");
    return "held";
  }
  const nowIso = new Date(nowMs).toISOString();
  await db.from("care_cases").update({ owner_alert_status: "sent", owner_alerted_at: nowIso }).eq("id", caseRow.id).eq("owner_alert_status", "sending");
  if (ids.length && company.ownerPhone) {
    await db.from("owner_approvals").update({ notified_at: nowIso, notified_to: company.ownerPhone }).in("id", ids).eq("status", "pending");
  }
  return "sent";
}

export interface WarrantyClaimInput {
  company: CareCompany;
  contact: CareContact;
  problem: string | null;
  warranty: JobWarrantyRow | null;
  equipment: InstalledEquipmentRow | null;
  fact: string;
  jobLabel: string | null;
  ownerFirst: string | null;
  conversationId?: string | null;
  nowMs: number;
}

export type WarrantyClaimResult = { ok: true; caseRow: CareCaseRow; approvalId: string; shortCode: number | null } | { ok: false; reason: "already_open" | "error" };

/** One open warranty claim per customer (partial unique index). The owner is asked through notifyOwnerOfApproval. */
export async function openWarrantyClaim(admin: AdminClient, input: WarrantyClaimInput): Promise<WarrantyClaimResult> {
  const { company } = input;
  const scope = { organizationId: company.organizationId, companyId: company.companyId };
  const db = admin as Db;
  const { data: open } = await db
    .from("care_cases")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", input.contact.id)
    .eq("kind", "warranty")
    .eq("status", "open")
    .limit(1);
  if (((open ?? []) as unknown[]).length > 0) return { ok: false, reason: "already_open" };
  const name = customerName(input.contact);
  const { data: inserted, error } = await db
    .from("care_cases")
    .insert({
      organization_id: scope.organizationId,
      company_id: scope.companyId,
      contact_id: input.contact.id,
      booking_id: input.warranty?.booking_id ?? input.equipment?.booking_id ?? null,
      job_label: input.jobLabel,
      kind: "warranty",
      status: "open",
      summary: input.problem?.slice(0, 1000) ?? null,
      opened_via: "sms_agent",
      warranty_id: input.warranty?.id ?? null,
      equipment_id: input.equipment?.id ?? null,
      owner_alert_status: "none",
      created_at: new Date(input.nowMs).toISOString(),
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return { ok: false, reason: "already_open" };
    throw error;
  }
  const caseRow = inserted as CareCaseRow;
  try {
    const approval = await insertApproval(admin, {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      contactId: input.contact.id,
      conversationId: input.conversationId ?? null,
      kind: WARRANTY_CLAIM_KIND,
      summary: warrantyClaimSummary(name, input.problem, input.fact),
      payload: { caseId: caseRow.id, contactId: input.contact.id, customerName: name, customerFirst: input.contact.first_name ?? null, jobLabel: input.jobLabel, ownerFirst: input.ownerFirst, fact: input.fact },
      requestedBy: CARE_REQUESTED_BY,
      createdAt: new Date(input.nowMs),
      expiresAt: expiryInHours(input.nowMs, APPROVAL_TTL_MS, company.timeZone),
    });
    await db.from("care_cases").update({ approval_ids: [approval.id] }).eq("id", caseRow.id).eq("organization_id", scope.organizationId);
    await notifyOwnerOfApproval(admin, approval.id, { nowMs: input.nowMs });
    return { ok: true, caseRow: { ...caseRow, approval_ids: [approval.id] }, approvalId: approval.id, shortCode: approval.short_code };
  } catch (err) {
    console.error("[customer-care] could not ask about the warranty claim:", err instanceof Error ? err.message : err);
    await db.from("care_cases").update({ status: "closed", notes: "Couldn't ask the owner (error)." }).eq("id", caseRow.id).eq("organization_id", scope.organizationId);
    return { ok: false, reason: "error" };
  }
}

/** The owner's own heads-up when a case closes itself or something can't be sent (best-effort). */
export async function tellOwner(admin: AdminClient, company: CareCompany, body: string, nowMs: number): Promise<boolean> {
  return (await textOwner(admin, company, body, nowMs)) === "sent";
}
