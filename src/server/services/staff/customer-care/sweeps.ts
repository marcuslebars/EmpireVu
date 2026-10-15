/**
 * Customer care's sweeps (through runStaffSweeps). Companies are loaded at most once a minute per
 * worker (loadCareCompanies: done-for-you companies with the role and the SMS agent on, plus house-org
 * companies that opted in — filtered at the query, so A1 never enters a sweep unless switched on).
 *
 *   customer_care:jobs      (5 min)  new job completions → check-in planned + job warranty
 *   customer_care:checkins  (5 min)  due check-ins sent (09:00–20:00 local)
 *   customer_care:outbox    (2 min)  queued customer texts, held owner alerts, stuck rows
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { sendCaseAlert } from "./cases";
import { dueCheckins, planCompany, recentBookingEvents, recentCompletions, sendCheckin } from "./checkins";
import type { CareCaseRow, Db } from "./db-types";
import { dueMessages, failStuck, sendClaimed, skipMessage } from "./outbox";
import { loadCareCompanies, type CareCompany } from "./settings";
import { inCustomerWindow } from "./time";
import { reopenCancelledVisits, tidyOffers } from "./visits";

let cache: { atMs: number; companies: CareCompany[] } | null = null;

export async function careCompaniesCached(admin: AdminClient, nowMs: number): Promise<CareCompany[]> {
  if (cache && nowMs - cache.atMs < 60_000 && nowMs >= cache.atMs) return cache.companies;
  const companies = await loadCareCompanies(admin);
  cache = { atMs: nowMs, companies };
  return companies;
}

/** Test hook. */
export function resetCareCompanyCache(): void {
  cache = null;
}

export async function sweepJobs(admin: AdminClient, nowMs: number): Promise<number> {
  const companies = await careCompaniesCached(admin, nowMs);
  if (companies.length === 0) return 0;
  const events = await recentCompletions(admin, companies, nowMs);
  const byCompany = new Map(companies.map((c) => [c.companyId, c]));
  const grouped = new Map<string, typeof events>();
  for (const e of events) {
    const company = e.company_id ? byCompany.get(e.company_id) : undefined;
    if (!company || company.organizationId !== e.organization_id) continue;
    const list = grouped.get(company.companyId) ?? [];
    list.push(e);
    grouped.set(company.companyId, list);
  }
  let planned = 0;
  for (const [companyId, list] of grouped) {
    try {
      planned += await planCompany(admin, byCompany.get(companyId) as CareCompany, list, nowMs);
    } catch (err) {
      console.error("[customer-care] planning failed for", companyId, err instanceof Error ? err.message : err);
    }
  }
  // Cancelled callback / warranty visits: their case goes back to open (and the owner is told).
  const cancelled = await recentBookingEvents(admin, companies, nowMs, "booking.cancelled");
  const cancelledBy = new Map<string, string[]>();
  for (const e of cancelled) {
    const company = e.company_id ? byCompany.get(e.company_id) : undefined;
    if (!company || company.organizationId !== e.organization_id || !e.entity_id) continue;
    cancelledBy.set(company.companyId, [...(cancelledBy.get(company.companyId) ?? []), e.entity_id]);
  }
  for (const [companyId, bookingIds] of cancelledBy) {
    await reopenCancelledVisits(admin, byCompany.get(companyId) as CareCompany, [...new Set(bookingIds)], nowMs).catch((err: unknown) =>
      console.error("[customer-care] reopening cancelled visits failed for", companyId, err instanceof Error ? err.message : err),
    );
  }
  return planned;
}

export async function sweepCheckins(admin: AdminClient, nowMs: number): Promise<number> {
  const companies = await careCompaniesCached(admin, nowMs);
  if (companies.length === 0) return 0;
  const byCompany = new Map(companies.map((c) => [c.companyId, c]));
  const due = await dueCheckins(admin, [...byCompany.keys()], nowMs);
  let sent = 0;
  for (const row of due) {
    const company = byCompany.get(row.company_id);
    if (!company || company.organizationId !== row.organization_id) continue;
    try {
      if ((await sendCheckin(admin, company, row, nowMs)) === "sent") sent++;
    } catch (err) {
      console.error("[customer-care] check-in failed", row.id, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}

export async function sweepOutbox(admin: AdminClient, nowMs: number): Promise<void> {
  const companies = await careCompaniesCached(admin, nowMs);
  if (companies.length === 0) return;
  const byCompany = new Map(companies.map((c) => [c.companyId, c]));
  const ids = [...byCompany.keys()];
  const db = admin as Db;

  // 1. Queued customer texts that are due (re-checked: the case still wants them).
  for (const row of await dueMessages(admin, nowMs, ids)) {
    const company = byCompany.get(row.company_id);
    if (!company || company.organizationId !== row.organization_id || !inCustomerWindow(nowMs, company.timeZone)) continue;
    try {
      if (nowMs - Date.parse(row.created_at) > 3 * 86_400_000) {
        await skipMessage(admin, row, "too old");
        continue;
      }
      if (row.case_id) {
        const { data } = await db.from("care_cases").select("id, status, visit_stage").eq("id", row.case_id).eq("organization_id", row.organization_id).maybeSingle();
        const c = data as Pick<CareCaseRow, "status" | "visit_stage"> | null;
        if (!c || c.status === "resolved" || c.status === "closed") {
          await skipMessage(admin, row, "case closed");
          continue;
        }
        if (row.kind === "visit_offer" && c.visit_stage !== "offered") {
          await skipMessage(admin, row, "visit no longer offered");
          continue;
        }
      }
      await sendClaimed(admin, row, nowMs);
    } catch (err) {
      console.error("[customer-care] outbox send failed", row.id, err instanceof Error ? err.message : err);
    }
  }

  // 2. Owner alerts held for the morning (or a missing / unverified cell, now fixed).
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from("care_cases").select("*").eq("owner_alert_status", "pending").in("company_id", ids.slice(i, i + 200)).limit(200);
    if (error) throw error;
    for (const c of (data ?? []) as CareCaseRow[]) {
      const company = byCompany.get(c.company_id);
      if (!company || company.organizationId !== c.organization_id) continue;
      await sendCaseAlert(admin, company, c, nowMs).catch((err: unknown) => console.error("[customer-care] owner alert failed", c.id, err instanceof Error ? err.message : err));
    }
  }

  // 3. Visit offers: unanswered for 14 days → the owner; a crashed booking claim → offered again.
  await tidyOffers(admin, companies, nowMs);

  // 4. Rows a crashed worker left mid-send: failed, never re-sent.
  await failStuck(admin, nowMs, ids);
  const stale = new Date(nowMs - 10 * 60_000).toISOString();
  for (let i = 0; i < ids.length; i += 200) {
    await db.from("care_checkins").update({ status: "failed", reason: "stuck sending" }).eq("status", "sending").in("company_id", ids.slice(i, i + 200)).lt("updated_at", stale);
    await db.from("care_cases").update({ owner_alert_status: "pending" }).eq("owner_alert_status", "sending").in("company_id", ids.slice(i, i + 200)).lt("updated_at", stale);
  }
}
