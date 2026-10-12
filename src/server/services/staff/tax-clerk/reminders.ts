/**
 * The HST reminder (sweep `tax_clerk:hst`): 10 days before a period's payment is due, between
 * 09:00 and 20:00 local, one text per company per period:
 *
 *   #12 Q3 HST: collected $1,240, ITCs $380, owing about $860. Due Oct 31. Prepared figures - you
 *   or your accountant file the return. Y emails the Q3 packet to books@acct.ca. Text 'hst' for
 *   the breakdown. Reply Y 12 to email it, N 12 to skip.
 *
 * It is an `accountant_packet` approval (notified through notifyOwnerOfApproval) when there's
 * somewhere to send the packet, else a plain owner text. Only for registrants with reminders on.
 * hst_periods (unique company + period) is the claim: inserted before anything is read, so
 * overlapping workers text once. A failed pass is retried (3 attempts, 30 min apart).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { localDate } from "@/server/services/booking-windows";
import { localHour } from "@/server/services/owner-channel/common";
import { ACCOUNTANT_PACKET_KIND, createPacketApproval, defaultTaxApprovalDeps, type TaxApprovalDeps } from "./approvals";
import type { Db, HstPeriodRow } from "./db-types";
import { addDaysTo, DISCLAIMER, lastEndedPeriod, reminderText, worksheetFor, type HstPeriod } from "./hst";
import { defaultPacketDeps, loadPeriodRow, packetDestination, type PacketDeps } from "./packet";
import { hstRemindersOn, type TaxClerkCompany } from "./settings";

export const REMIND_DAYS_BEFORE = 10;
const RETRY_AFTER_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

export interface ReminderDeps {
  approvals: TaxApprovalDeps;
  packet: PacketDeps;
  sendOwnerSms: typeof sendOwnerSms;
}

export const defaultReminderDeps: ReminderDeps = { approvals: defaultTaxApprovalDeps, packet: defaultPacketDeps, sendOwnerSms };

/** The period to remind about today, or null (outside the 10-day window). PURE. */
export function periodToRemind(today: string, company: Pick<TaxClerkCompany, "settings">): HstPeriod | null {
  const period = lastEndedPeriod(today, company.settings.hst);
  const from = addDaysTo(period.paymentDueDate, -REMIND_DAYS_BEFORE);
  return today >= from && today <= period.paymentDueDate ? period : null;
}

async function claimPeriod(admin: AdminClient, company: TaxClerkCompany, period: HstPeriod, nowMs: number): Promise<HstPeriodRow | null> {
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await db
    .from("hst_periods")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      frequency: period.frequency,
      period_start: period.start,
      period_end: period.end,
      due_date: period.dueDate,
      payment_due_date: period.paymentDueDate,
      label: period.label,
      status: "reminding",
      attempts: 1,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("*")
    .single();
  if (!error && data) return data as HstPeriodRow;
  const existing = await loadPeriodRow(admin, company, period);
  if (!existing) return null;
  // Made for a packet the owner asked for (no reminder yet), or a failed pass due a retry.
  const retry = existing.status === "failed" && existing.attempts < MAX_ATTEMPTS && nowMs - Date.parse(existing.updated_at) >= RETRY_AFTER_MS;
  if (existing.status !== "pending" && !retry) return null;
  const { data: claimed } = await db
    .from("hst_periods")
    .update({ status: "reminding", attempts: existing.attempts + 1, updated_at: nowIso })
    .eq("id", existing.id)
    .eq("organization_id", company.organizationId)
    .eq("status", existing.status)
    .eq("attempts", existing.attempts)
    .select("*");
  return ((claimed ?? []) as HstPeriodRow[])[0] ?? null;
}

export type ReminderOutcome = "not_due" | "off" | "no_phone" | "claimed_elsewhere" | "asked" | "texted" | "failed";

/** One company's reminder pass. */
export async function runCompanyHstReminder(admin: AdminClient, company: TaxClerkCompany, nowMs: number, deps: ReminderDeps = defaultReminderDeps): Promise<ReminderOutcome> {
  if (!hstRemindersOn(company.settings)) return "off";
  if (!company.ownerPhone) return "no_phone";
  const today = localDate(new Date(nowMs), company.timeZone);
  const hour = localHour(nowMs, company.timeZone);
  if (hour < 9 || hour >= 20) return "not_due";
  const period = periodToRemind(today, company);
  if (!period) return "not_due";
  const row = await claimPeriod(admin, company, period, nowMs);
  if (!row) return "claimed_elsewhere";
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  try {
    const w = await worksheetFor(admin, company, period);
    const text = reminderText(period, w, Number(today.slice(0, 4)));
    const dest = await packetDestination(admin, company, deps.packet);
    const figures = { salesCents: w.salesCents, collectedCents: w.collectedCents, itcCents: w.itcCents, netCents: w.netCents, invoiceCount: w.invoiceCount, expenseCount: w.expenseCount };
    if (dest) {
      const summary = `${text} ${DISCLAIMER} Y emails the ${period.label} packet to ${dest.to}. Text 'hst' for the breakdown.`;
      const approval = await createPacketApproval(
        admin,
        {
          organizationId: company.organizationId,
          companyId: company.companyId,
          summary,
          payload: { frequency: period.frequency, periodStart: period.start, periodEnd: period.end, label: period.label, to: dest.to, toWho: dest.toWho },
        },
        nowMs,
        deps.approvals,
      );
      await db
        .from("hst_periods")
        .update({ status: "reminded", reminded_at: nowIso, updated_at: nowIso, reminder_body: summary.slice(0, 700), figures, approval_id: approval.id })
        .eq("id", row.id)
        .eq("organization_id", company.organizationId);
      return "asked";
    }
    const body = `${text} ${DISCLAIMER} Text 'hst' for the breakdown. Add your accountant's email in Settings > AI front desk > Receipts & HST and I'll send them the packet.`;
    const sent = await deps.sendOwnerSms(admin, { to: company.ownerPhone, body, organizationId: company.organizationId, companyId: company.companyId, platformBrand: company.platformBrand });
    const ok = sent.status === "sent";
    await db
      .from("hst_periods")
      .update({ status: ok ? "reminded" : sent.status === "blocked" ? "skipped" : "failed", reminded_at: ok ? nowIso : null, updated_at: nowIso, reminder_body: body.slice(0, 700), figures })
      .eq("id", row.id)
      .eq("organization_id", company.organizationId);
    return ok ? "texted" : "failed";
  } catch (err) {
    console.error("[tax-clerk] HST reminder failed:", err instanceof Error ? err.message : err);
    await db.from("hst_periods").update({ status: "failed", updated_at: nowIso }).eq("id", row.id).eq("organization_id", company.organizationId);
    return "failed";
  }
}

export async function sweepHstReminders(admin: AdminClient, nowMs: number, companies: TaxClerkCompany[], deps: ReminderDeps = defaultReminderDeps): Promise<void> {
  for (const company of companies) {
    try {
      await runCompanyHstReminder(admin, company, nowMs, deps);
    } catch (err) {
      console.error("[tax-clerk] HST reminder failed for a company:", err instanceof Error ? err.message : err);
    }
  }
}

export { ACCOUNTANT_PACKET_KIND };
