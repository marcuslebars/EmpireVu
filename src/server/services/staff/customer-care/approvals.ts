/**
 * Executors for Customer care's approval kinds (docs/ai-staff.md → "Customer care & warranty").
 *
 *   care_followup  (two rows per unhappy check-in answer, one owner text)
 *     visit row Y → the customer is texted 2–3 open times for a callback visit
 *     call row  Y → the customer is texted "Mike will call you today"; the conversation is the owner's
 *     N (either) → nothing is sent; the case stays open
 *     expiry     → nothing is sent; the case stays open; the owner is told (08:00–21:00)
 *   warranty_claim
 *     Y → the customer is texted times for a no-charge warranty visit
 *     N / expiry → the customer is told the owner will call; the conversation is the owner's
 *
 * Idempotent: the first decision claims the case (followup_decided_at is null → set) before
 * anything is sent, and supersedes the sibling care_followup row; a repeat answers "already".
 * Neither kind takes a note (the owner channel refuses a price note before it gets here).
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import { markOwnerTakeover } from "@/server/services/sms-agent/takeover";
import type { CareCaseRow, Db } from "./db-types";
import { loadCase } from "./cases";
import { loadContact, queueAndSend } from "./outbox";
import { textOwner } from "./owner";
import { loadCareCompany, type CareCompany } from "./settings";
import { customerName, firstNameOf, ownerCallText, willCallText } from "./texts";
import { nextOpeningLabel } from "./time";
import { offerVisit } from "./visits";

type Followup = "visit" | "call" | "none" | "expired";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function claimCase(admin: AdminClient, caseRow: CareCaseRow, followup: Followup, nowMs: number): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("care_cases")
    .update({ followup, followup_decided_at: new Date(nowMs).toISOString() })
    .eq("id", caseRow.id)
    .eq("organization_id", caseRow.organization_id)
    .is("followup_decided_at", null)
    .select("id");
  return ((data ?? []) as unknown[]).length > 0;
}

/** The other care_followup row of the same case is withdrawn once one is decided. */
async function supersedeSiblings(admin: AdminClient, caseRow: CareCaseRow, approvalId: string): Promise<void> {
  const others = (caseRow.approval_ids ?? []).filter((id) => id !== approvalId);
  if (others.length === 0) return;
  await (admin as Db).from("owner_approvals").update({ status: "superseded" }).in("id", others).eq("organization_id", caseRow.organization_id).eq("status", "pending");
}

function alreadyLine(caseRow: CareCaseRow, name: string): string {
  const what =
    caseRow.followup === "visit" ? "a visit was offered" : caseRow.followup === "call" ? "they were told you'll call" : caseRow.followup === "none" ? "you left it" : "it expired";
  return `Already handled: for ${name}, ${what}.`;
}

async function context(admin: AdminClient, approval: OwnerApprovalRow): Promise<{ company: CareCompany; caseRow: CareCaseRow } | { error: ExecuteResult }> {
  const caseId = str(approval.payload.caseId);
  const company = await loadCareCompany(admin, approval.organization_id, approval.company_id);
  if (!company) return { error: { ok: false, message: "That business isn't on file any more, so nothing was sent." } };
  const caseRow = caseId ? await loadCase(admin, { organizationId: company.organizationId, companyId: company.companyId }, caseId) : null;
  if (!caseRow) return { error: { ok: false, message: `#${approval.short_code ?? "?"} isn't linked to a customer care case any more, so nothing was sent.` } };
  return { company, caseRow };
}

async function tellCustomerOwnerCalls(admin: AdminClient, company: CareCompany, caseRow: CareCaseRow, ownerFirst: string | null, body: "call_today" | "will_call", nowMs: number): Promise<{ outcome: string; name: string; phone: string }> {
  const contact = await loadContact(admin, company.organizationId, caseRow.contact_id);
  const name = customerName(contact);
  const phone = (contact?.phone ? prettyPhone(contact.phone) : null) ?? "no number on file";
  await (admin as Db).from("care_cases").update({ visit_stage: "owner_calls" }).eq("id", caseRow.id).eq("organization_id", company.organizationId);
  if (!contact) return { outcome: "skipped", name, phone };
  const first = firstNameOf(contact);
  const text = body === "call_today" ? ownerCallText(company.name, first, ownerFirst, caseRow.job_label) : willCallText(company.name, first, ownerFirst, caseRow.job_label);
  const outcome = await queueAndSend(admin, {
    scope: { organizationId: company.organizationId, companyId: company.companyId },
    timeZone: company.timeZone,
    caseId: caseRow.id,
    contactId: contact.id,
    kind: "owner_call",
    dedupeKey: caseRow.id,
    body: text,
    nowMs,
  });
  // The owner is calling: the assistant stays out of this conversation (72 h, or until turned back on).
  await markOwnerTakeover(admin, { companyId: company.companyId, contactId: contact.id, at: new Date(nowMs) });
  return { outcome, name, phone };
}

export async function executeCareFollowup(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  const nowMs = Date.now();
  const ctx = await context(admin, approval);
  if ("error" in ctx) return ctx.error;
  const { company, caseRow } = ctx;
  const option = approval.payload.option === "call" ? "call" : "visit";
  const followup: Followup = decision.approved ? option : decision.decidedVia === "expiry" ? "expired" : "none";
  const name = str(approval.payload.customerName) ?? "the customer";
  if (!(await claimCase(admin, caseRow, followup, nowMs))) {
    const fresh = (await loadCase(admin, { organizationId: company.organizationId, companyId: company.companyId }, caseRow.id)) ?? caseRow;
    return { ok: true, message: alreadyLine(fresh, name) };
  }
  await supersedeSiblings(admin, caseRow, approval.id);
  if (caseRow.status === "resolved" || caseRow.status === "closed") return { ok: true, message: `${name}'s case is already closed, so nothing was sent.` };
  const ownerFirst = str(approval.payload.ownerFirst);

  if (followup === "visit") return offerVisit(admin, company, caseRow, "callback", nowMs);
  if (followup === "call") {
    const told = await tellCustomerOwnerCalls(admin, company, caseRow, ownerFirst, "call_today", nowMs);
    if (told.outcome === "queued") return { ok: true, message: `It's late, so ${told.name} gets "you'll call today" at ${nextOpeningLabel(nowMs, company.timeZone)}. Their number: ${told.phone}.` };
    if (told.outcome === "sent" || told.outcome === "duplicate") return { ok: true, message: `Texted ${told.name} that you'll call today. Their number: ${told.phone}.` };
    return { ok: false, message: `I couldn't text ${told.name} (${told.outcome}). Their number: ${told.phone}.` };
  }
  if (followup === "none") return { ok: true, message: `OK - nothing sent to ${name}. The case stays open; text "resolve ${name}" when it's sorted.` };
  const codes = `#${approval.short_code ?? "?"}`;
  await textOwner(admin, company, `No answer on ${codes}, so nothing was sent to ${name}. Their case stays open - text "care status" to see it.`, nowMs);
  return { ok: true, message: `Expired - nothing sent to ${name}; the case stays open.` };
}

export async function executeWarrantyClaim(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  const nowMs = Date.now();
  const ctx = await context(admin, approval);
  if ("error" in ctx) return ctx.error;
  const { company, caseRow } = ctx;
  const followup: Followup = decision.approved ? "visit" : decision.decidedVia === "expiry" ? "expired" : "none";
  const name = str(approval.payload.customerName) ?? "the customer";
  if (!(await claimCase(admin, caseRow, followup, nowMs))) {
    const fresh = (await loadCase(admin, { organizationId: company.organizationId, companyId: company.companyId }, caseRow.id)) ?? caseRow;
    return { ok: true, message: alreadyLine(fresh, name) };
  }
  if (caseRow.status === "resolved" || caseRow.status === "closed") return { ok: true, message: `${name}'s case is already closed, so nothing was sent.` };
  if (followup === "visit") return offerVisit(admin, company, caseRow, "warranty", nowMs);
  const told = await tellCustomerOwnerCalls(admin, company, caseRow, str(approval.payload.ownerFirst), "will_call", nowMs);
  const late = told.outcome === "queued" ? ` (they get the text at ${nextOpeningLabel(nowMs, company.timeZone)})` : "";
  if (followup === "expired") {
    await textOwner(admin, company, `No answer on #${approval.short_code ?? "?"}, so I told ${told.name} you'll give them a call about the warranty question${late}. Their number: ${told.phone}.`, nowMs);
    return { ok: true, message: `Expired - told ${told.name} you'll call.` };
  }
  return { ok: true, message: `OK - I told ${told.name} you'll give them a call${late}. Their number: ${told.phone}.` };
}
