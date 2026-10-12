/**
 * Service plans' background passes (runStaffSweeps; each throttled and isolated):
 *
 *   service-plans:payments  (5 min)  plan invoices paid (card, a bank debit that cleared, an
 *                                    e-Transfer the owner recorded) → start / renew; sign-ups never
 *                                    paid after 3 days → cancelled (invoice voided); an active plan
 *                                    missing its series (a crash mid-start) gets it.
 *   service-plans:renewals  (30 min) Monday 09:00–17:00 local, once a week per company: the
 *                                    plan_renewals batch (terms ending in the next 30 days). Daily
 *                                    09:00–20:00: a term that ended → renewal_due; 14 days after
 *                                    the term ended, unpaid → lapsed (owner texted).
 *   service-plans:heads-up  (30 min) 09:00–20:00 local: one text per plan visit ~10 days ahead.
 *   service-plans:queue     (2 min)  customer texts that waited for 09:00, re-checked first.
 *
 * Only agreements are scanned (they only exist for CrankLeads companies with a plan), so a company
 * without plans — every house org — costs nothing. A company that is no longer CrankLeads, is
 * paused / archived, or switched the feature off is skipped.
 */
import { localDate, weekdayOf } from "@/server/services/booking-windows";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { localHour } from "@/server/services/owner-channel/common";
import { cancelAgreement, contactName, defaultPlanDeps, ensureSeries, lapseAgreement, settlePlanInvoice, type PlanDeps } from "./agreements";
import { createPlanApproval, PLAN_RENEWALS_KIND, supersedeApproval } from "./approval-kinds";
import { invoiceStates, isPaid } from "./billing";
import type { Db, PlanMessageRow, ServiceAgreementRow } from "./db-types";
import { dueMessages, inCustomerWindow, loadContact, queueAndSend, sendClaimed, skipMessage } from "./messages";
import { loadPlan, planSchedule } from "./plans";
import { addDaysYmd, termEndFor, termVisitDates, visitName } from "./schedule";
import { HEADS_UP_DAYS, LAPSE_GRACE_DAYS, loadPlanCompanies, PENDING_PAYMENT_DAYS, RENEWAL_WINDOW_DAYS, type PlanCompany } from "./settings";
import { firstNameOf, headsUpText, renewalsSummary } from "./texts";

const DAY = 86_400_000;

async function agreementsWhere(admin: AdminClient, build: (q: Db) => Db, limit = 1000): Promise<ServiceAgreementRow[]> {
  const { data, error } = await build((admin as Db).from("service_agreements").select("*")).limit(limit);
  if (error) throw error;
  return (data ?? []) as ServiceAgreementRow[];
}

function usable(company: PlanCompany | undefined): company is PlanCompany {
  return Boolean(company && company.crankleads && company.active && company.settings.enabled);
}

// ── Payments ────────────────────────────────────────────────────────────────

export async function sweepPayments(admin: AdminClient, nowMs: number, deps: PlanDeps = defaultPlanDeps): Promise<{ settled: number; abandoned: number; repaired: number }> {
  const out = { settled: 0, abandoned: 0, repaired: 0 };
  const waiting = await agreementsWhere(admin, (q) => q.in("status", ["pending_payment", "active", "renewal_due"]).not("pending_invoice_id", "is", null).order("created_at", { ascending: true }), 500);
  const companies = await loadPlanCompanies(admin, waiting.map((a) => a.company_id));
  const byOrg = new Map<string, ServiceAgreementRow[]>();
  for (const a of waiting) byOrg.set(a.organization_id, [...(byOrg.get(a.organization_id) ?? []), a]);
  for (const [orgId, rows] of byOrg) {
    const states = await invoiceStates(admin, orgId, rows.map((r) => r.pending_invoice_id as string));
    for (const row of rows) {
      const company = companies.get(row.company_id);
      if (!company?.crankleads) continue;
      const state = states.get(row.pending_invoice_id as string);
      if (isPaid(state)) {
        const result = await settlePlanInvoice(admin, row.pending_invoice_id as string, nowMs, deps, async () => company);
        if (result !== "noop") out.settled += 1;
        continue;
      }
      const stale = row.status === "pending_payment" && Date.parse(row.created_at) < nowMs - PENDING_PAYMENT_DAYS * DAY;
      if (stale && (!state || state.pendingPaymentCents === 0)) {
        const cancelled = await cancelAgreement(admin, company, row, "never paid", nowMs, deps);
        if (cancelled.ok) out.abandoned += 1;
      }
    }
  }
  // A plan that started but lost its series to a crash mid-start.
  const orphans = await agreementsWhere(admin, (q) => q.eq("status", "active").is("recurring_job_id", null).lt("activated_at", new Date(nowMs - 5 * 60_000).toISOString()), 100);
  const orphanCompanies = await loadPlanCompanies(admin, orphans.map((a) => a.company_id));
  for (const row of orphans) {
    const company = orphanCompanies.get(row.company_id);
    if (!company?.crankleads) continue;
    try {
      const plan = await loadPlan(admin, company, row.plan_id);
      if (await ensureSeries(admin, row, plan, nowMs)) out.repaired += 1;
    } catch (err) {
      console.error(`[service-plans] series repair for ${row.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── Renewals and lapses ─────────────────────────────────────────────────────

async function claimRun(admin: AdminClient, companyId: string, kind: string, runKey: string): Promise<boolean> {
  const { error } = await (admin as Db).from("service_plan_runs").insert({ company_id: companyId, kind, run_key: runKey });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

async function releaseRun(admin: AdminClient, companyId: string, kind: string, runKey: string): Promise<void> {
  await (admin as Db).from("service_plan_runs").delete().eq("company_id", companyId).eq("kind", kind).eq("run_key", runKey);
}

/** The weekly plan_renewals approval for one company (Monday). Returns the approval id or null. */
export async function runRenewalBatch(admin: AdminClient, company: PlanCompany, nowMs: number, deps: PlanDeps = defaultPlanDeps): Promise<string | null> {
  const today = localDate(new Date(nowMs), company.timeZone);
  const until = addDaysYmd(today, RENEWAL_WINDOW_DAYS);
  if (!(await claimRun(admin, company.companyId, "renewals", today))) return null;
  try {
    const rows = (
      await agreementsWhere(admin, (q) =>
        q
          .eq("organization_id", company.organizationId)
          .eq("company_id", company.companyId)
          .in("status", ["active", "renewal_due"])
          .gte("term_end", today)
          .lte("term_end", until)
          .is("renewal_approval_id", null)
          .is("renewal_declined_at", null)
          .is("renewal_texted_at", null)
          .order("term_end", { ascending: true }),
      )
    ).filter((r) => r.contact_id && !r.renewed_by_agreement_id);
    if (rows.length === 0) return null;
    const lines = await Promise.all(
      rows.map(async (r) => {
        const plan = await loadPlan(admin, company, r.plan_id);
        const contact = await loadContact(admin, company.organizationId, r.contact_id);
        const start = addDaysYmd(r.term_end as string, 1);
        const next = plan ? termVisitDates({ ...planSchedule(plan), months: r.visit_months }, start, termEndFor(start))[0] : null;
        return {
          name: contactName(contact, r.customer_name),
          renewsOn: start,
          priceCents: plan?.active ? plan.price_cents : r.price_cents,
          billing: r.billing,
          nextVisitName: next ? visitName(next, r.visit_months) : null,
        };
      }),
    );
    const approval = await createPlanApproval(
      admin,
      {
        organizationId: company.organizationId,
        companyId: company.companyId,
        kind: PLAN_RENEWALS_KIND,
        summary: renewalsSummary(lines, RENEWAL_WINDOW_DAYS),
        payload: { agreementIds: rows.map((r) => r.id), windowDays: RENEWAL_WINDOW_DAYS },
      },
      nowMs,
      deps.approvals,
    );
    const { data: linked } = await (admin as Db)
      .from("service_agreements")
      .update({ renewal_approval_id: approval.id, renewal_asked_at: new Date(nowMs).toISOString() })
      .eq("organization_id", company.organizationId)
      .in("id", rows.map((r) => r.id))
      .is("renewal_approval_id", null)
      .select("id");
    if (((linked ?? []) as unknown[]).length === 0) {
      await supersedeApproval(admin, approval.id);
      return null;
    }
    return approval.id;
  } catch (err) {
    await releaseRun(admin, company.companyId, "renewals", today);
    throw err;
  }
}

export async function sweepRenewals(admin: AdminClient, nowMs: number, deps: PlanDeps = defaultPlanDeps): Promise<{ batches: number; lapsed: number; due: number }> {
  const out = { batches: 0, lapsed: 0, due: 0 };
  const horizon = new Date(nowMs + (RENEWAL_WINDOW_DAYS + 2) * DAY).toISOString().slice(0, 10);
  const rows = await agreementsWhere(admin, (q) => q.in("status", ["active", "renewal_due"]).lte("term_end", horizon).order("term_end", { ascending: true }), 2000);
  const companies = await loadPlanCompanies(admin, rows.map((r) => r.company_id));
  const perCompany = new Map<string, ServiceAgreementRow[]>();
  for (const r of rows) perCompany.set(r.company_id, [...(perCompany.get(r.company_id) ?? []), r]);
  for (const [companyId, list] of perCompany) {
    const company = companies.get(companyId);
    if (!usable(company)) continue;
    try {
      const today = localDate(new Date(nowMs), company.timeZone);
      const hour = localHour(nowMs, company.timeZone);
      if (inCustomerWindow(nowMs, company.timeZone)) {
        for (const r of list) {
          if (!r.term_end) continue;
          if (addDaysYmd(r.term_end, LAPSE_GRACE_DAYS) < today) {
            if ((await lapseAgreement(admin, company, r, nowMs, deps)).ok) out.lapsed += 1;
          } else if (r.term_end < today && r.status === "active") {
            const { data } = await (admin as Db).from("service_agreements").update({ status: "renewal_due" }).eq("organization_id", company.organizationId).eq("id", r.id).eq("status", "active").select("id");
            out.due += ((data ?? []) as unknown[]).length;
          }
        }
      }
      if (company.settings.renewals.enabled && weekdayOf(today) === 1 && hour >= 9 && hour < 17) {
        if (await runRenewalBatch(admin, company, nowMs, deps)) out.batches += 1;
      }
    } catch (err) {
      console.error(`[service-plans] renewals for ${companyId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── Visit heads-up ──────────────────────────────────────────────────────────

/**
 * Does one of the company's own "booking coming up" automations already text far enough ahead
 * (≥ 3 days)? Then it covers the heads-up and we stay quiet. The default reminder (24 h + 2 h
 * before) doesn't: it's the day-before reminder, the heads-up is the "it's coming up" a week+ out.
 */
export async function reminderCoversHeadsUp(admin: AdminClient, company: PlanCompany): Promise<boolean> {
  const { data, error } = await (admin as Db)
    .from("workflows")
    .select("id, company_id, status, definition")
    .eq("organization_id", company.organizationId)
    .eq("trigger_event", "booking.upcoming")
    .eq("status", "active");
  if (error) return false;
  return ((data ?? []) as Array<{ company_id: string | null; definition: unknown }>).some((w) => {
    if (w.company_id && w.company_id !== company.companyId) return false;
    const def = (w.definition ?? {}) as { schedule?: { hours_before?: unknown }; actions?: Array<{ type?: unknown }> };
    const hours = typeof def.schedule?.hours_before === "number" ? def.schedule.hours_before : 24;
    return hours >= 72 && Array.isArray(def.actions) && def.actions.some((a) => a?.type === "send_sms");
  });
}

function localHhmm(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export async function sweepHeadsUp(admin: AdminClient, nowMs: number, deps: PlanDeps = defaultPlanDeps): Promise<{ sent: number; skipped: number }> {
  const out = { sent: 0, skipped: 0 };
  const rows = (await agreementsWhere(admin, (q) => q.in("status", ["active", "renewal_due"]).not("recurring_job_id", "is", null), 5000)).filter((r) => r.recurring_job_id);
  const companies = await loadPlanCompanies(admin, rows.map((r) => r.company_id));
  const perCompany = new Map<string, ServiceAgreementRow[]>();
  for (const r of rows) perCompany.set(r.company_id, [...(perCompany.get(r.company_id) ?? []), r]);
  const from = new Date(nowMs + (HEADS_UP_DAYS - 1) * DAY).toISOString();
  const to = new Date(nowMs + (HEADS_UP_DAYS + 0.5) * DAY).toISOString();
  for (const [companyId, list] of perCompany) {
    const company = companies.get(companyId);
    if (!usable(company) || !company.settings.headsUp.enabled || !inCustomerWindow(nowMs, company.timeZone)) continue;
    try {
      if (await reminderCoversHeadsUp(admin, company)) continue;
      const bySeries = new Map(list.map((a) => [a.recurring_job_id as string, a]));
      const { data, error } = await (admin as Db)
        .from("bookings")
        .select("id, recurring_job_id, scheduled_for, status")
        .eq("organization_id", company.organizationId)
        .eq("company_id", company.companyId)
        .in("recurring_job_id", [...bySeries.keys()])
        .in("status", ["pending", "confirmed"])
        .gte("scheduled_for", from)
        .lte("scheduled_for", to);
      if (error) throw error;
      for (const b of (data ?? []) as Array<{ id: string; recurring_job_id: string; scheduled_for: string }>) {
        const agreement = bySeries.get(b.recurring_job_id);
        if (!agreement) continue;
        const contact = await loadContact(admin, company.organizationId, agreement.contact_id);
        const date = localDate(new Date(b.scheduled_for), company.timeZone);
        const body = headsUpText({ firstName: firstNameOf(contact?.first_name ?? agreement.customer_name), businessName: company.name, date, timeOfDay: localHhmm(b.scheduled_for, company.timeZone), planMonths: agreement.visit_months });
        const outcome = await queueAndSend(admin, { company, agreement, bookingId: b.id, kind: "visit_heads_up", dedupeKey: b.id, body, nowMs }, deps.messages);
        if (outcome === "sent" || outcome === "queued") out.sent += 1;
        else if (outcome !== "duplicate") out.skipped += 1;
      }
    } catch (err) {
      console.error(`[service-plans] heads-up for ${companyId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ── The queue ───────────────────────────────────────────────────────────────

/** Is a waiting text still right to send? Returns the reason it isn't, or null. */
async function staleReason(admin: AdminClient, row: PlanMessageRow, agreement: ServiceAgreementRow | null, nowMs: number): Promise<string | null> {
  if (nowMs - Date.parse(row.created_at) > 3 * DAY) return "too late";
  if (!agreement) return "agreement gone";
  switch (row.kind) {
    case "renewal":
      return agreement.status === "renewal_due" ? null : `plan is ${agreement.status}`;
    case "confirmation":
    case "renewed":
      return agreement.status === "active" || agreement.status === "renewal_due" ? null : `plan is ${agreement.status}`;
    case "declined":
      return agreement.status === "cancelled" ? null : `plan is ${agreement.status}`;
    case "visit_heads_up": {
      if (!row.booking_id) return "no visit";
      const { data } = await (admin as Db).from("bookings").select("status, scheduled_for").eq("organization_id", row.organization_id).eq("id", row.booking_id).maybeSingle();
      const b = data as { status: string; scheduled_for: string } | null;
      if (!b || !["pending", "confirmed"].includes(b.status) || Date.parse(b.scheduled_for) <= nowMs) return "visit changed";
      if (!["active", "renewal_due"].includes(agreement.status)) return `plan is ${agreement.status}`;
      return null;
    }
    default:
      return null;
  }
}

export async function sweepQueue(admin: AdminClient, nowMs: number, deps: PlanDeps = defaultPlanDeps): Promise<{ sent: number; skipped: number }> {
  const out = { sent: 0, skipped: 0 };
  const rows = await dueMessages(admin, nowMs);
  if (rows.length === 0) return out;
  const companies = await loadPlanCompanies(admin, rows.map((r) => r.company_id));
  for (const row of rows) {
    const company = companies.get(row.company_id);
    if (!company) continue;
    if (!usable(company)) {
      await skipMessage(admin, row, "service plans off", nowMs);
      out.skipped += 1;
      continue;
    }
    if (!inCustomerWindow(nowMs, company.timeZone)) continue;
    const { data } = row.agreement_id
      ? await (admin as Db).from("service_agreements").select("*").eq("organization_id", row.organization_id).eq("id", row.agreement_id).maybeSingle()
      : { data: null };
    const agreement = (data as ServiceAgreementRow | null) ?? null;
    const reason = await staleReason(admin, row, agreement, nowMs);
    if (reason || !agreement) {
      await skipMessage(admin, row, reason ?? "agreement gone", nowMs);
      out.skipped += 1;
      continue;
    }
    const contact = await loadContact(admin, company.organizationId, agreement.contact_id);
    const result = await sendClaimed(admin, company, row, agreement, contact, nowMs, deps.messages);
    if (result === "sent") out.sent += 1;
    else if (result !== "duplicate") out.skipped += 1;
  }
  return out;
}
