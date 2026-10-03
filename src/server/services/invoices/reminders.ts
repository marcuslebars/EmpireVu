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
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { emitInvoiceTrigger, loadCompanyForInvoice, recordInvoiceEvent, todayFor, type CompanyForInvoice, type Db } from "./common";
import { daysBetween, dueReminderIndex } from "./math";
import { sendInvoiceReminderEmail } from "./notify";
import { parseInvoiceSettings } from "./settings";

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
    .select("id, organization_id, company_id, contact_id, quote_id, due_date, reminder_count, last_reminder_at, balance_due_cents, pending_payment_cents")
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
    if (!settings.remindersEnabled) continue;
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
