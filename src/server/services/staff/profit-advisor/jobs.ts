/**
 * Job profit for the Profit advisor: a tiny service-role wrapper around the app's own job costing
 * (time/service.ts profitReport — revenue from the invoice, else the approved quote / series price;
 * cost = labour × pay rates + job materials + receipts on the job before tax). Nothing here
 * re-implements that maths; time/service.ts is not edited.
 *
 * profitReport is org-scoped and returns at most 500 jobs, so a long window is asked for in
 * 31-day slices (`truncated` says if any slice hit the cap). Past jobs brought in by the customer
 * import (bookings.source_call_id "import:…") are history, not work done, and are left out
 * (reports/exclusions.ts). Each row also carries what the advisor needs on top: the booked length,
 * how many crew were on it, the quote and the price-list item.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { isImportedPastJob } from "@/server/services/reports/exclusions";
import { isPrepaidPlanVisit } from "@/server/services/staff/service-plans/prepaid";
import type { TenantServiceContext } from "@/server/services/shared";
import { profitReport, type ProfitRow } from "@/server/services/time/service";
import type { Db } from "./db-types";

const SLICE_MS = 31 * 86_400_000;

export interface JobProfitRow extends ProfitRow {
  durationMinutes: number;
  crewCount: number;
  quoteId: string | null;
  serviceItemId: string | null;
  /**
   * A visit the customer isn't billed for: a Customer care callback / warranty visit
   * (care_case_bookings) or a visit already paid for by an annual service plan. Not a "job done"
   * and never "no price yet"; its cost is reported on its own (see summary.ts).
   */
  freeVisit: "care" | "plan" | null;
}

export interface JobProfits {
  rows: JobProfitRow[];
  missingRateNames: string[];
  /** A slice returned profitReport's 500-job cap (very busy business) — numbers may be partial. */
  truncated: boolean;
}

/**
 * Booking ids that are Customer care callback / warranty visits — the same table and rule as
 * customer-care/care-visit.ts isCareVisitBooking, read in one batch. Tolerant: no table → none.
 */
async function careVisitIds(db: Db, organizationId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from("care_case_bookings").select("booking_id").eq("organization_id", organizationId).in("booking_id", ids.slice(i, i + 200));
      if (error) return new Set();
      for (const r of (data ?? []) as Array<{ booking_id: string }>) out.add(r.booking_id);
    }
  } catch {
    return new Set();
  }
  return out;
}

/** A service-role context pinned to one organization (profitReport filters by it). */
export function serviceCtx(admin: AdminClient, organizationId: string): TenantServiceContext {
  return { organizationId, actorProfileId: null, supabase: admin as TenantServiceContext["supabase"] };
}

/** Completed jobs scheduled in [fromIso, toIso), newest first, with their profit. */
export async function loadJobProfits(admin: AdminClient, scope: { organizationId: string; companyId: string }, fromIso: string, toIso: string, nowMs: number): Promise<JobProfits> {
  const ctx = serviceCtx(admin, scope.organizationId);
  const rows: ProfitRow[] = [];
  const missing = new Set<string>();
  let truncated = false;
  for (let end = Date.parse(toIso); end > Date.parse(fromIso); end -= SLICE_MS) {
    const start = Math.max(Date.parse(fromIso), end - SLICE_MS);
    const part = await profitReport(ctx, { from: new Date(start).toISOString(), to: new Date(end).toISOString(), companyId: scope.companyId }, new Date(nowMs));
    if (part.rows.length >= 500) truncated = true;
    rows.push(...part.rows);
    part.missingRateNames.forEach((n) => missing.add(n));
  }
  if (rows.length === 0) return { rows: [], missingRateNames: [], truncated };
  const db = admin as Db;
  const meta = new Map<string, Record<string, unknown>>();
  const crew = new Map<string, Set<string>>();
  const ids = rows.map((r) => r.bookingId);
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const [{ data: bookings, error: e1 }, { data: assigned, error: e2 }] = await Promise.all([
      db.from("bookings").select("id, source_call_id, quote_id, service_item_id, duration_minutes, recurring_job_id, occurrence_date, scheduled_for").eq("organization_id", scope.organizationId).eq("company_id", scope.companyId).in("id", part),
      db.from("booking_assignments").select("booking_id, profile_id").eq("organization_id", scope.organizationId).in("booking_id", part),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    for (const b of (bookings ?? []) as Array<Record<string, unknown>>) meta.set(String(b.id), b);
    for (const a of (assigned ?? []) as Array<{ booking_id: string; profile_id: string }>) crew.set(a.booking_id, (crew.get(a.booking_id) ?? new Set()).add(a.profile_id));
  }
  const care = await careVisitIds(db, scope.organizationId, ids);
  const out: JobProfitRow[] = [];
  for (const r of rows) {
    const b = meta.get(r.bookingId);
    // Not this company's (profitReport filters by company already), or an imported past job.
    if (!b || isImportedPastJob({ source_call_id: (b.source_call_id as string | null) ?? null })) continue;
    out.push({
      ...r,
      durationMinutes: typeof b.duration_minutes === "number" ? b.duration_minutes : 0,
      crewCount: crew.get(r.bookingId)?.size ?? 0,
      quoteId: (b.quote_id as string | null) ?? null,
      serviceItemId: (b.service_item_id as string | null) ?? null,
      freeVisit: care.has(r.bookingId)
        ? "care"
        : r.revenueCents <= 0 && b.recurring_job_id && (await isPrepaidPlanVisit(scope.organizationId, String(b.recurring_job_id), String(b.occurrence_date ?? b.scheduled_for ?? r.scheduledFor), admin))
          ? "plan"
          : null,
    });
  }
  out.sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));
  return { rows: out, missingRateNames: [...missing], truncated };
}
