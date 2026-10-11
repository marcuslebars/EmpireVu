/**
 * The Bookkeeper's owner approvals (docs/ai-staff.md → "Bookkeeper"):
 *
 *   collections_final_notice  the sweep proposes a "final reminder" after the last scheduled text
 *   payment_plan              a customer asked (SMS agent tool request_payment_plan)
 *   record_payment            the owner texted "Jones paid $500 by e-transfer" (owner tool)
 *   send_invoice_reminder     the owner texted "remind Jones" (owner tool)
 *
 * Every summary shows exactly what Y does (amounts, names, dates, the exact customer text). The
 * executors run once per decision (the owner channel claimed the row) and are idempotent for
 * retries: texts are claimed by invoice_reminder_texts' unique key, plans by the approval id,
 * payments by the approval id in their notes.
 */
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { insertApproval } from "@/server/services/front-desk/approvals";
import { parseOwnerNote } from "@/server/services/front-desk/owner-note";
import { recordInvoiceEvent } from "@/server/services/invoices/common";
import { recordPayment } from "@/server/services/invoices/service";
import type { InvoicePaymentMethod } from "@/server/services/invoices/settings";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import { markOwnerTakeover } from "@/server/services/sms-agent/takeover";
import { ensureCollections, isOpen, loadCompanyCtx, loadContact, loadInvoice, owingCents, payLink, tenantCtx, type CompanyCtx } from "./context";
import type { Db, Instalment } from "./db-types";
import { queueReminder, type SendOutcome } from "./deliver";
import { firstNameOf, nextWindowLabel, ownerMoney } from "./format";
import { planConfirmText, planDates, planDeclinedText, planShape } from "./texts";

export const KIND_FINAL_NOTICE = "collections_final_notice";
export const KIND_PAYMENT_PLAN = "payment_plan";
export const KIND_RECORD_PAYMENT = "record_payment";
export const KIND_SEND_REMINDER = "send_invoice_reminder";
export const BOOKKEEPER_KINDS = [KIND_FINAL_NOTICE, KIND_PAYMENT_PLAN, KIND_RECORD_PAYMENT, KIND_SEND_REMINDER] as const;

export const APPROVAL_TTL_MS: Record<string, number> = {
  [KIND_FINAL_NOTICE]: 3 * 86_400_000,
  [KIND_PAYMENT_PLAN]: 24 * 3_600_000,
  [KIND_RECORD_PAYMENT]: 24 * 3_600_000,
  [KIND_SEND_REMINDER]: 12 * 3_600_000,
};

export const PAYMENT_METHODS: Record<string, string> = {
  etransfer: "e-Transfer",
  cheque: "cheque",
  cash: "cash",
  card: "card",
  other: "payment",
};

const SUMMARY_MAX = 500;

// ── Creating ──────────────────────────────────────────────────────────────────

export interface NewBookkeeperApproval {
  organizationId: string;
  companyId: string;
  contactId: string | null;
  conversationId?: string | null;
  kind: (typeof BOOKKEEPER_KINDS)[number];
  summary: string;
  payload: Record<string, unknown>;
  /** The owner is asking right now by text: the reply carries the question (no separate notify). */
  inlineTo?: string | null;
}

export interface CreatedBookkeeperApproval {
  id: string;
  shortCode: number | null;
}

/**
 * Insert through the shared path (short code at insert), then ask the owner: inline (the owner
 * tool's reply IS the question) or via notifyOwnerOfApproval (quiet hours respected — non-urgent
 * approvals wait for 08:00; the owner channel's sweep sends them).
 */
export async function createBookkeeperApproval(admin: AdminClient, input: NewBookkeeperApproval, nowMs: number = Date.now()): Promise<CreatedBookkeeperApproval> {
  const now = new Date(nowMs);
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: input.contactId,
    conversationId: input.conversationId ?? null,
    kind: input.kind,
    summary: input.summary.slice(0, SUMMARY_MAX),
    payload: input.payload,
    requestedBy: "bookkeeper",
    createdAt: now,
    expiresAt: new Date(nowMs + (APPROVAL_TTL_MS[input.kind] ?? 24 * 3_600_000)),
    notifiedAt: input.inlineTo ? now : null,
    notifiedTo: input.inlineTo ?? null,
  });
  if (!input.inlineTo) {
    try {
      await notifyOwnerOfApproval(admin, row.id, { nowMs });
    } catch (err) {
      console.error("[bookkeeper] notify failed", row.id, err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code };
}

/** An open approval of this kind for this invoice (one at a time). */
export async function pendingApprovalFor(admin: AdminClient, companyId: string, kind: string, invoiceId: string): Promise<{ id: string; short_code: number | null } | null> {
  const { data } = await (admin as Db)
    .from("owner_approvals")
    .select("id, short_code")
    .eq("company_id", companyId)
    .eq("kind", kind)
    .eq("status", "pending")
    .eq("payload->>invoiceId", invoiceId)
    .limit(1);
  return ((data ?? []) as Array<{ id: string; short_code: number | null }>)[0] ?? null;
}

/** The "Reply Y 12 …" line for an inline (owner-tool) approval. PURE. */
export function inlineReplyLine(kind: string, code: number | null): string {
  const c = code != null ? ` ${code}` : "";
  if (kind === KIND_RECORD_PAYMENT) return `Reply Y${c} to record it, N${c} to skip.`;
  if (kind === KIND_SEND_REMINDER) return `Reply Y${c} to send it, N${c} to skip.`;
  return `Reply Y${c} to approve, N${c} to skip.`;
}

// ── Executing ─────────────────────────────────────────────────────────────────

function payloadStr(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function payloadInt(p: Record<string, unknown>, key: string): number | null {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function code(approval: OwnerApprovalRow): string {
  return `#${approval.short_code ?? "?"}`;
}

/**
 * Owner notes on Bookkeeper kinds. The SMS reply parser only ever passes a price, and none of
 * these kinds takes a new price, so a note is fine only when it repeats the amount shown.
 */
function noteProblem(decision: ApprovalDecision, shownCents: number | null): string | null {
  const note = parseOwnerNote(decision.ownerNote);
  if (note.kind === "none") return null;
  if (note.kind === "price" && shownCents != null && note.cents === shownCents) return null;
  return "that one can't take a different amount";
}

function outcomeLine(outcome: SendOutcome, who: string, what: string, ctx: CompanyCtx, nowMs: number): ExecuteResult {
  switch (outcome.status) {
    case "sent":
      return { ok: true, message: `Sent the ${what} to ${who}.` };
    case "queued":
      return { ok: true, message: `OK - the ${what} goes to ${who} at ${nextWindowLabel(nowMs, ctx.timeZone)} (customer texts go out 9am-8pm, Mon-Sat).` };
    case "blocked":
      return {
        ok: false,
        message: `Couldn't text ${who}: ${outcome.reason === "opted_out" ? "they've opted out of texts" : outcome.reason === "no_phone" ? "no mobile number on file" : "they haven't agreed to texts"}. Nothing sent.`,
      };
    case "skipped":
      return {
        ok: outcome.reason === "paid_or_closed",
        message: outcome.reason === "paid_or_closed" ? `No need - ${who}'s invoice is paid or closed. Nothing sent.` : `Nothing sent to ${who}: the balance changed since. Text me "remind ${who.split(" ")[0]}" for a fresh one.`,
      };
    default:
      return { ok: false, message: `The text to ${who} didn't go through - try again from the app.` };
  }
}

/** collections_final_notice + send_invoice_reminder: queue the exact text the owner saw. */
async function executeReminderKind(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, kind: "final_notice" | "manual"): Promise<ExecuteResult> {
  const nowMs = Date.now();
  const p = approval.payload;
  const what = kind === "final_notice" ? "final notice" : "reminder";
  const db = admin as Db;
  const invoiceId = payloadStr(p, "invoiceId");
  const who = payloadStr(p, "customerName") ?? "the customer";
  const markFinal = async (status: string) => {
    if (kind !== "final_notice" || !invoiceId) return;
    await db.from("invoice_collections").update({ final_notice_status: status }).eq("organization_id", approval.organization_id).eq("invoice_id", invoiceId).eq("final_notice_approval_id", approval.id);
  };
  if (!decision.approved) {
    await markFinal("skipped");
    if (decision.decidedVia === "expiry") return { ok: true, message: `No answer on ${code(approval)} - the ${what} to ${who} wasn't sent.` };
    return { ok: true, message: kind === "final_notice" ? `OK, no final notice for ${who}. The automatic texts for that invoice are done.` : `OK, no reminder sent to ${who}.` };
  }
  const balanceCents = payloadInt(p, "balanceCents");
  const problem = noteProblem(decision, balanceCents);
  if (problem) return { ok: false, message: `Nothing sent - ${problem}. Text me "remind ${who.split(" ")[0]}" to start again.` };
  const text = payloadStr(p, "text");
  const ctx = await loadCompanyCtx(admin, approval.organization_id, approval.company_id);
  const invoice = invoiceId && ctx ? await loadInvoice(admin, ctx, invoiceId) : null;
  if (!ctx || !invoice || !text || balanceCents == null) return { ok: false, message: `I couldn't find that invoice any more - nothing sent.` };
  if (!isOpen(invoice)) {
    await markFinal("skipped");
    return { ok: true, message: `No need - ${who}'s invoice is already paid or closed. Nothing sent.` };
  }
  await markFinal("approved");
  const outcome = await queueReminder(
    admin,
    ctx,
    invoice,
    { key: kind === "final_notice" ? "final" : `manual:${approval.id}`, kind: kind === "final_notice" ? "final_notice" : "manual", body: text, balanceCents, approvalId: approval.id },
    nowMs,
  );
  return { ...outcomeLine(outcome, who, what, ctx, nowMs), detail: { invoiceId: invoice.id, outcome: outcome.status } };
}

export async function executeFinalNotice(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  return executeReminderKind(admin, approval, decision, "final_notice");
}

export async function executeSendReminder(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  return executeReminderKind(admin, approval, decision, "manual");
}

/** record_payment: recordPayment for the amount shown, once (the approval id is in the notes). */
export async function executeRecordPayment(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  const p = approval.payload;
  const who = payloadStr(p, "customerName") ?? "the customer";
  if (!decision.approved) {
    return { ok: true, message: decision.decidedVia === "expiry" ? `No answer on ${code(approval)} - nothing recorded for ${who}.` : "OK, nothing recorded." };
  }
  const amountCents = payloadInt(p, "amountCents");
  const invoiceId = payloadStr(p, "invoiceId");
  const method = (payloadStr(p, "method") ?? "other") as InvoicePaymentMethod;
  if (!amountCents || !invoiceId) return { ok: false, message: "That request was missing the amount or invoice - nothing recorded." };
  const problem = noteProblem(decision, amountCents);
  if (problem) return { ok: false, message: `Nothing recorded - ${problem}. Text me the payment again with the right amount.` };

  const scope = { organizationId: approval.organization_id, companyId: approval.company_id };
  const invoice = await loadInvoice(admin, scope, invoiceId);
  if (!invoice) return { ok: false, message: "I couldn't find that invoice any more - nothing recorded." };
  const marker = `approval ${approval.id}`;
  const { data: already } = await (admin as Db)
    .from("invoice_payments")
    .select("id")
    .eq("organization_id", approval.organization_id)
    .eq("invoice_id", invoice.id)
    .ilike("notes", `%${marker}%`)
    .limit(1);
  if (((already ?? []) as unknown[]).length > 0) return { ok: true, message: `Already recorded ${ownerMoney(amountCents)} from ${who}.` };

  try {
    const { invoice: updated } = await recordPayment(tenantCtx(admin, approval.organization_id), invoice.id, {
      amountCents,
      method,
      receivedAt: payloadStr(p, "receivedAt"),
      reference: payloadStr(p, "reference"),
      notes: `Recorded by text from the owner (${marker})`,
    });
    const left = Math.max(0, updated.balance_due_cents - (updated.pending_payment_cents ?? 0));
    if (left === 0) {
      await (admin as Db)
        .from("invoice_collections")
        .update({ promise_status: "kept", hold_until: null, hold_reason: null })
        .eq("organization_id", approval.organization_id)
        .eq("invoice_id", invoice.id)
        .eq("promise_status", "open");
    }
    const number = invoice.invoice_number ? ` on ${invoice.invoice_number}` : "";
    return {
      ok: true,
      message: `Recorded ${ownerMoney(amountCents)} ${PAYMENT_METHODS[method] ?? "payment"} from ${who}${number} - ${left > 0 ? `${ownerMoney(left)} still owing` : "paid in full"}.`,
      detail: { invoiceId: invoice.id, amountCents, balanceCents: left },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "it didn't save";
    return { ok: false, message: `Nothing recorded: ${reason}` };
  }
}

function asInstalments(raw: unknown): Instalment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) => i as Record<string, unknown>)
    .filter((i) => typeof i.n === "number" && typeof i.dueDate === "string" && typeof i.amountCents === "number")
    .map((i) => ({ n: i.n as number, dueDate: i.dueDate as string, amountCents: i.amountCents as number }));
}

/** payment_plan: on Y the plan starts (reminders before each payment); on N the owner takes over. */
export async function executePaymentPlan(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  const db = admin as Db;
  const nowMs = Date.now();
  const p = approval.payload;
  const who = payloadStr(p, "customerName") ?? "the customer";
  const ctx = await loadCompanyCtx(admin, approval.organization_id, approval.company_id);
  if (!ctx) return { ok: false, message: "That business isn't there any more." };
  const contact = await loadContact(admin, ctx, approval.contact_id);

  if (!decision.approved) {
    if (contact) await markOwnerTakeover(admin, { companyId: ctx.companyId, contactId: contact.id });
    if (decision.decidedVia === "expiry") {
      return { ok: true, message: `No answer on ${code(approval)} - ${who}'s payment plan wasn't set up. Their texts are with you now.` };
    }
    // Queued like every Bookkeeper text: right away inside 9am-8pm Mon-Sat, else at the next 9am;
    // the consent anchor is the invoice, as for the reminders.
    const invoice = await loadInvoice(admin, ctx, payloadStr(p, "invoiceId"));
    let told = "no plan";
    if (contact && invoice) {
      const reply = planDeclinedText({ businessName: ctx.name, firstName: firstNameOf(contact), ownerName: ctx.ownerFirstName });
      const outcome = await queueReminder(admin, ctx, invoice, { key: `plan:${approval.id}:decline`, kind: "plan_notice", body: reply, balanceCents: null, approvalId: approval.id }, nowMs);
      if (outcome.status === "sent") told = `told ${who} you'll be in touch about the payment`;
      else if (outcome.status === "queued") told = `I'll tell ${who} at ${nextWindowLabel(nowMs, ctx.timeZone)} that you'll be in touch`;
    }
    return { ok: true, message: `OK - ${told}. Their texts are with you now.` };
  }

  const instalments = asInstalments(p.instalments);
  const balanceCents = payloadInt(p, "balanceCents");
  const problem = noteProblem(decision, null);
  if (problem) return { ok: false, message: `No plan set up - ${problem}. Reply to the customer yourself, or have them ask again.` };
  const invoice = await loadInvoice(admin, ctx, payloadStr(p, "invoiceId"));
  if (!invoice || instalments.length < 2 || balanceCents == null) return { ok: false, message: "I couldn't find that invoice any more - no plan set up." };
  if (!isOpen(invoice)) return { ok: false, message: `${who}'s invoice is already paid or closed - no plan needed.` };
  if (owingCents(invoice) !== balanceCents) {
    return { ok: false, message: `No plan set up: ${who}'s balance changed to ${ownerMoney(owingCents(invoice))} since they asked. They can ask again.` };
  }

  const totalCents = instalments.reduce((s, i) => s + i.amountCents, 0);
  const { error } = await db
    .from("payment_plans")
    .insert({
      organization_id: ctx.organizationId,
      company_id: ctx.companyId,
      invoice_id: invoice.id,
      contact_id: invoice.contact_id,
      approval_id: approval.id,
      status: "active",
      instalments,
      total_cents: totalCents,
      starting_balance_cents: balanceCents,
      activated_at: new Date(nowMs).toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    const { data: mine } = await db.from("payment_plans").select("id").eq("organization_id", ctx.organizationId).eq("approval_id", approval.id).maybeSingle();
    if (mine) return { ok: true, message: `${who}'s payment plan is already set up.` };
    return { ok: false, message: `${who} already has a payment plan on that invoice - nothing changed.` };
  }
  await ensureCollections(admin, invoice);
  await db
    .from("invoice_collections")
    .update({ hold_until: instalments[instalments.length - 1].dueDate, hold_reason: "payment_plan", promise_status: null })
    .eq("organization_id", ctx.organizationId)
    .eq("invoice_id", invoice.id);
  await recordInvoiceEvent(admin as never, { organizationId: ctx.organizationId, invoiceId: invoice.id, eventType: "payment_plan_started", metadata: { approvalId: approval.id, instalments } });

  let told = "I'll remind them before each payment.";
  if (contact) {
    const reply = planConfirmText({
      businessName: ctx.name,
      firstName: firstNameOf(contact),
      ownerName: ctx.ownerFirstName,
      invoiceNumber: invoice.invoice_number,
      instalments,
      link: payLink(ctx, invoice),
    });
    const outcome = await queueReminder(admin, ctx, invoice, { key: `plan:${approval.id}:confirm`, kind: "plan_notice", body: reply, balanceCents: null, approvalId: approval.id }, nowMs);
    told =
      outcome.status === "sent"
        ? "Told them, and I'll remind them before each payment."
        : outcome.status === "queued"
          ? `I'll text them the plan at ${nextWindowLabel(nowMs, ctx.timeZone)}, and remind them before each payment.`
          : `Couldn't text them (${outcome.reason ?? "not sent"}) - let them know yourself.`;
  }
  return {
    ok: true,
    message: `Set up ${who}'s plan: ${planShape(instalments)} (${planDates(instalments)}). ${told}`,
    detail: { invoiceId: invoice.id, totalCents },
  };
}

export const bookkeeperExecutors = {
  [KIND_FINAL_NOTICE]: executeFinalNotice,
  [KIND_PAYMENT_PLAN]: executePaymentPlan,
  [KIND_RECORD_PAYMENT]: executeRecordPayment,
  [KIND_SEND_REMINDER]: executeSendReminder,
};
