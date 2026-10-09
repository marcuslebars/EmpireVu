/**
 * SANCTIONED EXCEPTION (service role): the overdue-invoice sweep, run once a day by
 * the quote-maintenance cron job. A background job has no session; it reads open
 * invoices across tenants and every write is pinned to the row's own id, with the
 * claim made in the UPDATE's WHERE clause so overlapping runs can't double-send.
 * Listed in docs/EMPIREVU_RUNBOOK.md (service-role surfaces).
 *
 * For each open invoice past its due date (in the brand's own time zone):
 *   1. invoice.overdue fires ONCE — the first day it is late — for automations
 *      (owner alert, a text to the customer…).
 *   2. If the brand has reminders on, the next reminder email goes out when the
 *      invoice reaches that many days late (default 1, 7, 14). At most one per
 *      invoice per run, so turning reminders on never sends a backlog at once.
 *      An invoice with its own reminders paused is skipped (it still turns overdue).
 *
 * Also here: the per-invoice schedule shown on the invoice ("next reminder Oct 15"),
 * pausing one invoice's reminders, and "Send reminder now".
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { TenantServiceContext } from "@/server/services/shared";
import { emitInvoiceTrigger, loadCompanyForInvoice, readBillTo, recordInvoiceEvent, todayFor, type CompanyForInvoice, type Db, type InvoiceRow } from "./common";
import { InvoiceConflictError, InvoiceNotFoundError } from "./errors";
import { addDays, daysBetween, dueReminderIndex, isOpenStatus } from "./math";
import { sendInvoiceReminderEmail } from "./notify";
import { parseInvoiceSettings, type InvoiceSettings } from "./settings";

export interface ReminderSweepResult {
  scanned: number;
  flaggedOverdue: string[];
  reminded: string[];
  failed: string[];
}

export async function sweepInvoiceReminders(now = new Date(), limit = 1000): Promise<ReminderSweepResult> {
  const db = createSupabaseAdminClient() as unknown as Db;
  // A day of slack on the cutoff: the exact "is it late" test runs per brand time zone below.
  const cutoff = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await db
    .from("invoices")
    .select("id, organization_id, company_id, contact_id, quote_id, due_date, reminder_count, last_reminder_at, balance_due_cents, pending_payment_cents, reminders_paused")
    .in("status", ["sent", "viewed", "partially_paid"])
    .lt("due_date", cutoff)
    .gt("balance_due_cents", 0)
    .order("due_date", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const result: ReminderSweepResult = { scanned: data?.length ?? 0, flaggedOverdue: [], reminded: [], failed: [] };
  const companies = new Map<string, CompanyForInvoice | null>();

  for (const inv of data ?? []) {
    if (!inv.due_date) continue;
    // A bank debit for the whole balance is clearing — not late, just slow.
    if (inv.pending_payment_cents >= inv.balance_due_cents) continue;

    if (!companies.has(inv.company_id)) {
      companies.set(inv.company_id, await loadCompanyForInvoice(db, inv.organization_id, inv.company_id));
    }
    const company = companies.get(inv.company_id) ?? null;
    const today = todayFor(company, now);
    const daysOverdue = daysBetween(inv.due_date, today);
    if (daysOverdue <= 0) continue;

    // 1. invoice.overdue, once.
    const { data: prior } = await db
      .from("invoice_events")
      .select("id")
      .eq("invoice_id", inv.id)
      .eq("event_type", "overdue")
      .limit(1);
    if ((prior ?? []).length === 0) {
      await recordInvoiceEvent(db, { organizationId: inv.organization_id, invoiceId: inv.id, eventType: "overdue", metadata: { daysOverdue } });
      await emitInvoiceTrigger(db, {
        organizationId: inv.organization_id,
        companyId: inv.company_id,
        contactId: inv.contact_id,
        invoiceId: inv.id,
        quoteId: inv.quote_id,
        eventType: "invoice.overdue",
        metadata: { daysOverdue },
      });
      result.flaggedOverdue.push(inv.id);
    }

    // 2. The next reminder email, if one is due.
    const settings = parseInvoiceSettings(company?.invoice_settings ?? null);
    if (!settings.remindersEnabled || inv.reminders_paused) continue;
    if (inv.last_reminder_at && todayFor(company, new Date(inv.last_reminder_at)) === today) continue;
    const index = dueReminderIndex(daysOverdue, settings.reminderDays, inv.reminder_count);
    if (index === null) continue;

    // Claim it: only the run that moves the count from N to N+1 sends.
    const { data: claimed } = await db
      .from("invoices")
      .update({ reminder_count: inv.reminder_count + 1, last_reminder_at: now.toISOString() })
      .eq("id", inv.id)
      .eq("reminder_count", inv.reminder_count)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    const outcome = await sendInvoiceReminderEmail(inv.id, { index, daysOverdue });
    (outcome.delivered ? result.reminded : result.failed).push(inv.id);
  }
  return result;
}

// ── The invoice's own reminder schedule ─────────────────────────────────────────

export type ReminderState =
  /** The next one is booked for `nextDate`. */
  | "scheduled"
  /** Reminders are off for this invoice only. */
  | "paused"
  /** The brand has reminders off (Settings → Invoices). */
  | "off"
  /** Every scheduled reminder has gone out. */
  | "done"
  /** No email address to send to. */
  | "no_email"
  /** Not an open invoice (draft, paid, void) — nothing to remind about. */
  | "closed";

export interface ReminderSchedule {
  state: ReminderState;
  paused: boolean;
  /** YYYY-MM-DD of the next automatic reminder (state "scheduled"). */
  nextDate: string | null;
  /** 1-based number of the next reminder, and how many the brand sends in all. */
  nextNumber: number | null;
  total: number;
  sentCount: number;
  lastSentAt: string | null;
  /** "Send reminder now" is possible (open, has a balance, has an email). */
  canSendNow: boolean;
}

/**
 * Where an invoice stands with reminders. Pure. The daily job sends a due reminder
 * on its next run, so a reminder that is already due shows as today — or tomorrow
 * if one went out today (the job sends at most one a day).
 */
export function reminderSchedule(
  invoice: Pick<InvoiceRow, "status" | "due_date" | "balance_due_cents" | "pending_payment_cents" | "reminder_count" | "last_reminder_at" | "reminders_paused" | "bill_to">,
  settings: Pick<InvoiceSettings, "remindersEnabled" | "reminderDays">,
  today: string,
  lastReminderDay: string | null,
): ReminderSchedule {
  const days = settings.reminderDays;
  const base = {
    paused: invoice.reminders_paused,
    nextDate: null,
    nextNumber: null,
    total: days.length,
    sentCount: invoice.reminder_count,
    lastSentAt: invoice.last_reminder_at,
  };
  const open = isOpenStatus(invoice.status) && invoice.balance_due_cents > 0;
  const hasEmail = Boolean(readBillTo(invoice.bill_to).email);
  const canSendNow = open && hasEmail;
  if (!open) return { ...base, state: "closed", canSendNow };
  if (!hasEmail) return { ...base, state: "no_email", canSendNow };
  if (invoice.reminders_paused) return { ...base, state: "paused", canSendNow };
  if (!settings.remindersEnabled || days.length === 0) return { ...base, state: "off", canSendNow };
  if (invoice.reminder_count >= days.length || !invoice.due_date) return { ...base, state: "done", canSendNow };

  let next = addDays(invoice.due_date, days[invoice.reminder_count]);
  if (next < today) next = today;
  if (lastReminderDay === today && next <= today) next = addDays(today, 1);
  return { ...base, state: "scheduled", nextDate: next, nextNumber: invoice.reminder_count + 1, canSendNow };
}

export function reminderScheduleFor(invoice: InvoiceRow, company: CompanyForInvoice | null, now = new Date()): ReminderSchedule {
  const settings = parseInvoiceSettings(company?.invoice_settings ?? null);
  const today = todayFor(company, now);
  const lastDay = invoice.last_reminder_at ? todayFor(company, new Date(invoice.last_reminder_at)) : null;
  return reminderSchedule(invoice, settings, today, lastDay);
}

// ── Staff actions ────────────────────────────────────────────────────────────────

async function loadForStaff(ctx: TenantServiceContext, invoiceId: string): Promise<InvoiceRow> {
  const { data, error } = await ctx.supabase.from("invoices").select("*").eq("organization_id", ctx.organizationId).eq("id", invoiceId).maybeSingle();
  if (error) throw error;
  if (!data) throw new InvoiceNotFoundError();
  return data as InvoiceRow;
}

/** Turn this one invoice's automatic reminders off (or back on). Under the caller's RLS. */
export async function setInvoiceRemindersPaused(ctx: TenantServiceContext, invoiceId: string, paused: boolean): Promise<InvoiceRow> {
  const invoice = await loadForStaff(ctx, invoiceId);
  if (invoice.reminders_paused === paused) return invoice;
  const { data, error } = await ctx.supabase
    .from("invoices")
    .update({ reminders_paused: paused })
    .eq("organization_id", ctx.organizationId)
    .eq("id", invoiceId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new InvoiceNotFoundError();
  await recordInvoiceEvent(ctx.supabase as unknown as Db, {
    organizationId: ctx.organizationId,
    invoiceId,
    eventType: paused ? "reminders_paused" : "reminders_resumed",
    actorProfileId: ctx.actorProfileId,
  });
  return data as InvoiceRow;
}

/** Two clicks (or two people) within this window send one reminder, not two. */
const SEND_NOW_GUARD_MS = 2 * 60_000;

/**
 * "Send reminder now": one reminder email right away, whatever the schedule says and
 * even when this invoice's reminders are paused (a person asked for it). It does NOT
 * use up a scheduled reminder — the schedule carries on as before — but it does count
 * as today's reminder, so the daily job won't send a second one the same day.
 */
export async function sendInvoiceReminderNow(ctx: TenantServiceContext, invoiceId: string, now = new Date()): Promise<{ delivered: boolean; reason: string | null; to: string | null }> {
  const invoice = await loadForStaff(ctx, invoiceId);
  if (!isOpenStatus(invoice.status) || invoice.balance_due_cents <= 0) {
    throw new InvoiceConflictError("Only an unpaid, sent invoice can get a reminder.");
  }
  if (!readBillTo(invoice.bill_to).email) {
    throw new InvoiceConflictError("There's no email address on this invoice — add one to the customer first.");
  }

  const db = createSupabaseAdminClient() as unknown as Db;
  // Claim: last_reminder_at is server-owned, and the conditional update is the guard
  // against a double click. (Plain eq/is filters — PostgREST re-applies an or=()
  // filter to the returned row, which would hide a won claim.)
  const previous = invoice.last_reminder_at;
  if (previous && now.getTime() - new Date(previous).getTime() < SEND_NOW_GUARD_MS) {
    throw new InvoiceConflictError("A reminder went out a moment ago.");
  }
  const base = db.from("invoices").update({ last_reminder_at: now.toISOString() }).eq("id", invoice.id).eq("organization_id", ctx.organizationId);
  const claim = previous ? base.eq("last_reminder_at", previous) : base.is("last_reminder_at", null);
  const { data: claimed, error } = await claim.select("id");
  if (error) throw error;
  if (!claimed || claimed.length === 0) throw new InvoiceConflictError("A reminder went out a moment ago.");

  const company = await loadCompanyForInvoice(db, invoice.organization_id, invoice.company_id);
  const daysOverdue = invoice.due_date ? daysBetween(invoice.due_date, todayFor(company, now)) : 0;
  const outcome = await sendInvoiceReminderEmail(invoice.id, {
    index: invoice.reminder_count,
    daysOverdue,
    manual: true,
    actorProfileId: ctx.actorProfileId,
  });
  if (!outcome.delivered) {
    // Give the day back so the schedule isn't held up by a send that didn't happen.
    await db.from("invoices").update({ last_reminder_at: previous }).eq("id", invoice.id).eq("organization_id", ctx.organizationId);
  }
  return { delivered: outcome.delivered, reason: outcome.reason, to: outcome.to ?? null };
}
