/**
 * The Bookkeeper's text-reminder sweep (every 15 minutes, every worker; claim-then-send):
 *
 *   1. Owner-approved texts waiting for the send window (final notices, "remind Jones") go out.
 *   2. Overdue invoices get the next scheduled reminder text (settings.reminderDays, default
 *      3/10/20/30 days late — between the email reminders' 1/7/14), gentle → firm, with the pay
 *      link. After the last one, a final notice is proposed to the owner (collections_final_notice).
 *   3. Payment-plan instalments get a reminder the day before (or the day of) each payment; a
 *      paid-off plan is closed.
 *
 * Rules: 09:00–20:00 local, Monday–Saturday only. At most one scheduled text per invoice per 5
 * days, one Bookkeeper text per customer per day, never on a day an email reminder went out
 * (invoices.last_reminder_at — both sides stamp it). Skipped: reminders_paused invoices, a hold
 * (promise to pay / plan), opted-out or no-consent contacts, conversations the owner is handling.
 * A catch-up never sends a backlog: an invoice that's 40 days late when texts are switched on gets
 * the day-30 text once, not four texts.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { checkConsent } from "@/server/services/workflow-engine/messaging";
import { prettyPhone } from "@/server/services/front-desk/approval-text";
import { createBookkeeperApproval, KIND_FINAL_NOTICE, pendingApprovalFor } from "./approvals";
import {
  collectionsFor,
  ensureCollections,
  isOpen,
  loadCompanyCtx,
  loadContact,
  OPEN_INVOICE_STATUSES,
  owingCents,
  payLink,
  reminderConsent,
  todayIn,
  type CompanyCtx,
} from "./context";
import { INVOICE_COLUMNS, type BookkeeperContact, type BookkeeperInvoice, type Db, type FinalNoticeStatus, type InvoiceCollectionsRow, type InvoiceReminderTextRow, type PaymentPlanRow } from "./db-types";
import { deliverQueuedReminder, sendClaimedReminder } from "./deliver";
import { addDays, daysBetween, firstNameOf, fullNameOf, inCustomerWindow, localParts, ownerMoney } from "./format";
import { finalNoticeText, instalmentText, reminderText, toneForStep, type ReminderInput, type ReminderTone } from "./texts";

/** Invoices more than this many days late are left to the owner (no texts, no final notice). */
export const MAX_CHASE_DAYS = 150;
/** At most one scheduled text per invoice in this many days. */
export const SMS_MIN_GAP_DAYS = 5;
/** The final notice is proposed this many days after the last scheduled text's day. */
export const FINAL_NOTICE_GAP_DAYS = 7;
/** One Bookkeeper text per customer in this window. */
export const PER_CONTACT_GAP_MS = 20 * 3_600_000;
/** A conversation the owner took over in the last N days means: leave the customer to them. */
export const OWNER_HANDLING_DAYS = 14;

export type NextText =
  | { action: "none"; why: "not_overdue" | "hold" | "reminded_today" | "gap" | "not_yet" | "done" }
  | { action: "text"; step: number; tone: ReminderTone }
  | { action: "final_notice" };

export interface NextTextInput {
  daysOverdue: number;
  reminderDays: number[];
  smsCount: number;
  /** Local date of the last scheduled text. */
  lastSmsDay: string | null;
  /** Local date of the last reminder of any kind (email or text: invoices.last_reminder_at). */
  lastReminderDay: string | null;
  today: string;
  holdUntil: string | null;
  finalNoticeStatus: FinalNoticeStatus;
  finalNoticeEnabled: boolean;
}

/** Which text (if any) an overdue invoice is due today. PURE. */
export function decideNextText(input: NextTextInput): NextText {
  const days = input.reminderDays;
  if (input.daysOverdue <= 0) return { action: "none", why: "not_overdue" };
  if (input.holdUntil && input.today <= input.holdUntil) return { action: "none", why: "hold" };
  if (input.lastReminderDay === input.today) return { action: "none", why: "reminded_today" };
  if (input.lastSmsDay && daysBetween(input.lastSmsDay, input.today) < SMS_MIN_GAP_DAYS) return { action: "none", why: "gap" };
  if (input.smsCount < days.length) {
    let step = -1;
    for (let i = input.smsCount; i < days.length; i++) if (days[i] <= input.daysOverdue) step = i;
    if (step < 0) return { action: "none", why: "not_yet" };
    return { action: "text", step, tone: toneForStep(step, days.length) };
  }
  const last = days[days.length - 1] ?? 0;
  if (input.finalNoticeEnabled && input.finalNoticeStatus === "none" && input.daysOverdue >= last + FINAL_NOTICE_GAP_DAYS) return { action: "final_notice" };
  return { action: "none", why: "done" };
}

export function reminderInput(ctx: CompanyCtx, invoice: BookkeeperInvoice, contact: BookkeeperContact | null, today: string): ReminderInput {
  return {
    businessName: ctx.name,
    firstName: firstNameOf(contact),
    invoiceNumber: invoice.invoice_number,
    owingCents: owingCents(invoice),
    dueDate: invoice.due_date,
    daysOverdue: invoice.due_date ? daysBetween(invoice.due_date, today) : 0,
    link: payLink(ctx, invoice),
  };
}

/** The owner's view of a final notice: who, what, and the exact text Y sends. ≤500 chars. PURE. */
export function finalNoticeSummary(input: { customerName: string; phone: string | null; invoiceNumber: string | null; owingCents: number; daysOverdue: number; textsSent: number; text: string }): string {
  const phone = prettyPhone(input.phone);
  const who = phone && phone !== input.customerName ? `${input.customerName} (${phone})` : input.customerName;
  const inv = input.invoiceNumber ? `${input.invoiceNumber}, ` : "";
  const sent = input.textsSent > 0 ? `, ${input.textsSent} reminder text${input.textsSent === 1 ? "" : "s"} sent` : "";
  const full = `Final notice for ${who}: ${inv}${ownerMoney(input.owingCents)} owing, ${input.daysOverdue} days overdue${sent}. Y texts them exactly: "${input.text}"`;
  if (full.length <= 500) return full;
  return `Final notice for ${input.customerName}: ${ownerMoney(input.owingCents)}, ${input.daysOverdue} days late. Y texts: "${input.text}"`.slice(0, 500);
}

/** The owner is handling this customer (took over recently, or paused the AI for them). */
export async function ownerHandling(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string, nowMs: number): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("sms_conversations")
    .select("state, owner_takeover_at")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .maybeSingle();
  const conv = data as { state: string; owner_takeover_at: string | null } | null;
  if (!conv) return false;
  if (conv.state === "paused") return true;
  if (conv.state !== "owner") return false;
  const at = conv.owner_takeover_at ? Date.parse(conv.owner_takeover_at) : Number.NaN;
  return !Number.isFinite(at) || nowMs - at < OWNER_HANDLING_DAYS * 86_400_000;
}

/** Did this customer get a Bookkeeper text in the last 20h? */
async function textedRecently(admin: AdminClient, scope: { organizationId: string; companyId: string }, contactId: string, nowMs: number): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("invoice_reminder_texts")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("company_id", scope.companyId)
    .eq("contact_id", contactId)
    .eq("status", "sent")
    .gte("sent_at", new Date(nowMs - PER_CONTACT_GAP_MS).toISOString())
    .limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

/** Claim a text by its unique key. Null → another run already has it. */
async function claimText(
  admin: AdminClient,
  ctx: CompanyCtx,
  invoice: BookkeeperInvoice,
  input: { key: string; kind: "scheduled" | "instalment"; body: string },
): Promise<InvoiceReminderTextRow | null> {
  const { data, error } = await (admin as Db)
    .from("invoice_reminder_texts")
    .insert({
      organization_id: ctx.organizationId,
      company_id: ctx.companyId,
      invoice_id: invoice.id,
      contact_id: invoice.contact_id,
      reminder_key: input.key,
      kind: input.kind,
      status: "claimed",
      body: input.body,
      balance_cents: owingCents(invoice),
    })
    .select("*")
    .single();
  if (error || !data) return null;
  return data as InvoiceReminderTextRow;
}

export interface ReminderSweepResult {
  queuedSent: number;
  texted: string[];
  finalNotices: string[];
  instalments: string[];
  plansClosed: string[];
}

class CompanyCache {
  private readonly map = new Map<string, Promise<CompanyCtx | null>>();
  constructor(private readonly admin: AdminClient) {}
  get(organizationId: string, companyId: string): Promise<CompanyCtx | null> {
    const key = `${organizationId}:${companyId}`;
    if (!this.map.has(key)) this.map.set(key, loadCompanyCtx(this.admin, organizationId, companyId).catch(() => null));
    return this.map.get(key)!;
  }
}

/** Can this customer get a proactive text from us right now? (consent + not with the owner) */
async function reachable(admin: AdminClient, ctx: CompanyCtx, invoice: BookkeeperInvoice, nowMs: number): Promise<BookkeeperContact | null> {
  const contact = await loadContact(admin, ctx, invoice.contact_id);
  if (!contact || !contact.phone?.trim()) return null;
  if (!checkConsent(reminderConsent(contact, invoice), "sms", nowMs).ok) return null;
  if (await ownerHandling(admin, ctx, contact.id, nowMs)) return null;
  return contact;
}

export async function runReminderSweep(admin: AdminClient, nowMs: number = Date.now(), limit = 500): Promise<ReminderSweepResult> {
  const db = admin as Db;
  const result: ReminderSweepResult = { queuedSent: 0, texted: [], finalNotices: [], instalments: [], plansClosed: [] };
  const companies = new CompanyCache(admin);
  const textedThisRun = new Set<string>();

  // 1. Owner-approved texts waiting for the window.
  const { data: queued } = await db.from("invoice_reminder_texts").select("*").eq("status", "queued").order("created_at", { ascending: true }).limit(100);
  for (const row of (queued ?? []) as InvoiceReminderTextRow[]) {
    const ctx = await companies.get(row.organization_id, row.company_id);
    if (!ctx || !inCustomerWindow(nowMs, ctx.timeZone)) continue;
    const outcome = await deliverQueuedReminder(admin, row, nowMs, ctx);
    if (outcome.status === "sent") {
      result.queuedSent++;
      if (row.contact_id) textedThisRun.add(row.contact_id);
    }
  }

  // 2. Scheduled reminder texts and final-notice proposals.
  const cutoff = new Date(nowMs + 86_400_000).toISOString().slice(0, 10);
  // Past the last possible step (120 days) + the final notice, an invoice is the owner's to chase:
  // leaving those out keeps years-old invoices from crowding the batch.
  const oldest = new Date(nowMs - MAX_CHASE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const { data: overdue } = await db
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .in("status", OPEN_INVOICE_STATUSES)
    .lt("due_date", cutoff)
    .gte("due_date", oldest)
    .gt("balance_due_cents", 0)
    .eq("reminders_paused", false)
    .order("due_date", { ascending: true })
    .limit(limit);
  const invoices = (overdue ?? []) as BookkeeperInvoice[];
  const byOrg = new Map<string, string[]>();
  for (const inv of invoices) byOrg.set(inv.organization_id, [...(byOrg.get(inv.organization_id) ?? []), inv.id]);
  const collections = new Map<string, InvoiceCollectionsRow>();
  for (const [org, ids] of byOrg) for (const [id, row] of await collectionsFor(admin, org, ids)) collections.set(id, row);

  for (const invoice of invoices) {
    try {
      if (!invoice.due_date || !invoice.contact_id || !isOpen(invoice) || invoice.reminders_paused) continue;
      const ctx = await companies.get(invoice.organization_id, invoice.company_id);
      if (!ctx || !ctx.settings.enabled || !ctx.settings.textReminders) continue;
      if (!inCustomerWindow(nowMs, ctx.timeZone)) continue;
      const today = todayIn(ctx, nowMs);
      const state = collections.get(invoice.id) ?? null;
      const decision = decideNextText({
        daysOverdue: daysBetween(invoice.due_date, today),
        reminderDays: ctx.settings.reminderDays,
        smsCount: state?.sms_count ?? 0,
        lastSmsDay: state?.last_sms_at ? localParts(Date.parse(state.last_sms_at), ctx.timeZone).date : null,
        lastReminderDay: invoice.last_reminder_at ? localParts(Date.parse(invoice.last_reminder_at), ctx.timeZone).date : null,
        today,
        holdUntil: state?.hold_until ?? null,
        finalNoticeStatus: state?.final_notice_status ?? "none",
        finalNoticeEnabled: ctx.settings.finalNotice,
      });
      if (decision.action === "none") continue;
      if (textedThisRun.has(invoice.contact_id)) continue;
      const contact = await reachable(admin, ctx, invoice, nowMs);
      if (!contact) continue;
      const input = reminderInput(ctx, invoice, contact, today);

      if (decision.action === "text") {
        if (await textedRecently(admin, ctx, contact.id, nowMs)) continue;
        const row = await claimText(admin, ctx, invoice, { key: `step:${decision.step + 1}`, kind: "scheduled", body: reminderText(input, decision.tone) });
        if (!row) continue;
        await ensureCollections(admin, invoice);
        await db
          .from("invoice_collections")
          .update({ sms_count: Math.max(decision.step + 1, state?.sms_count ?? 0), contact_id: invoice.contact_id })
          .eq("organization_id", ctx.organizationId)
          .eq("invoice_id", invoice.id);
        textedThisRun.add(contact.id);
        const outcome = await sendClaimedReminder(admin, ctx, invoice, contact, row, nowMs);
        if (outcome.status === "sent") result.texted.push(invoice.id);
        continue;
      }

      // decision.action === "final_notice": claim the proposal, then ask the owner.
      await ensureCollections(admin, invoice);
      const { data: claimed } = await db
        .from("invoice_collections")
        .update({ final_notice_status: "proposed" })
        .eq("organization_id", ctx.organizationId)
        .eq("invoice_id", invoice.id)
        .eq("final_notice_status", "none")
        .select("id");
      if (((claimed ?? []) as unknown[]).length === 0) continue;
      if (await pendingApprovalFor(admin, ctx.companyId, KIND_FINAL_NOTICE, invoice.id)) continue;
      const text = finalNoticeText(input);
      const created = await createBookkeeperApproval(
        admin,
        {
          organizationId: ctx.organizationId,
          companyId: ctx.companyId,
          contactId: contact.id,
          kind: KIND_FINAL_NOTICE,
          summary: finalNoticeSummary({
            customerName: fullNameOf(contact),
            phone: contact.phone,
            invoiceNumber: invoice.invoice_number,
            owingCents: input.owingCents,
            daysOverdue: input.daysOverdue,
            textsSent: state?.sms_count ?? 0,
            text,
          }),
          payload: { invoiceId: invoice.id, contactId: contact.id, customerName: fullNameOf(contact), text, balanceCents: input.owingCents, daysOverdue: input.daysOverdue },
        },
        nowMs,
      );
      await db.from("invoice_collections").update({ final_notice_approval_id: created.id }).eq("organization_id", ctx.organizationId).eq("invoice_id", invoice.id);
      result.finalNotices.push(invoice.id);
    } catch (err) {
      console.error("[bookkeeper] reminder sweep failed for invoice", invoice.id, err instanceof Error ? err.message : err);
    }
  }

  // 3. Payment plans: a reminder before each instalment; close paid-off plans.
  const { data: plans } = await db.from("payment_plans").select("*").eq("status", "active").order("activated_at", { ascending: true }).limit(limit);
  for (const plan of (plans ?? []) as PaymentPlanRow[]) {
    try {
      const ctx = await companies.get(plan.organization_id, plan.company_id);
      if (!ctx) continue;
      const { data: invRow } = await db.from("invoices").select(INVOICE_COLUMNS).eq("organization_id", plan.organization_id).eq("company_id", plan.company_id).eq("id", plan.invoice_id).maybeSingle();
      const invoice = invRow as BookkeeperInvoice | null;
      if (!invoice || !isOpen(invoice)) {
        await db.from("payment_plans").update({ status: invoice?.status === "void" ? "cancelled" : "completed", completed_at: new Date(nowMs).toISOString() }).eq("id", plan.id).eq("organization_id", plan.organization_id).eq("status", "active");
        await db.from("invoice_collections").update({ hold_until: null, hold_reason: null }).eq("organization_id", plan.organization_id).eq("invoice_id", plan.invoice_id).eq("hold_reason", "payment_plan");
        result.plansClosed.push(plan.id);
        continue;
      }
      if (!ctx.settings.enabled || invoice.reminders_paused || !inCustomerWindow(nowMs, ctx.timeZone)) continue;
      const today = todayIn(ctx, nowMs);
      const due = nextInstalmentToRemind(plan, owingCents(invoice), today);
      if (!due || !invoice.contact_id || textedThisRun.has(invoice.contact_id)) continue;
      const contact = await reachable(admin, ctx, invoice, nowMs);
      if (!contact || (await textedRecently(admin, ctx, contact.id, nowMs))) continue;
      const body = instalmentText({ businessName: ctx.name, firstName: firstNameOf(contact), instalment: due, of: plan.instalments.length, today, link: payLink(ctx, invoice) });
      const row = await claimText(admin, ctx, invoice, { key: `plan:${plan.id}:${due.n}`, kind: "instalment", body });
      if (!row) continue;
      textedThisRun.add(contact.id);
      const outcome = await sendClaimedReminder(admin, ctx, invoice, contact, row, nowMs);
      if (outcome.status === "sent") result.instalments.push(`${plan.id}:${due.n}`);
    } catch (err) {
      console.error("[bookkeeper] plan reminder failed", plan.id, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

/**
 * The instalment to remind about today: due tomorrow or today, and not already covered by what's
 * been paid since the plan started. PURE.
 */
export function nextInstalmentToRemind(plan: Pick<PaymentPlanRow, "instalments" | "starting_balance_cents">, owingNowCents: number, today: string) {
  const paid = Math.max(0, plan.starting_balance_cents - owingNowCents);
  let cumulative = 0;
  for (const inst of [...plan.instalments].sort((a, b) => a.n - b.n)) {
    cumulative += inst.amountCents;
    if (paid >= cumulative) continue;
    if (inst.dueDate === today || inst.dueDate === addDays(today, 1)) return inst;
    return null;
  }
  return null;
}
