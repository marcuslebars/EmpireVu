/**
 * SANCTIONED EXCEPTION (service role, one narrow read): job done → invoice (invoices/auto.ts) must
 * not bill a visit the customer already paid for with an ANNUAL service plan (one invoice per
 * term, paid up front) — and must bill every visit nobody paid for. Agreements are owner/admin-read under RLS, but a crew member's session
 * completes the job, so this one check reads with the service role — pinned to the booking's own
 * organization and series id, returning only yes/no.
 *
 * Only a booking of a series a service plan created can answer true; every other booking — A1's
 * recurring visits included — gets false, and any error (no service key, no table yet) is false,
 * so invoicing works exactly as before.
 */
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { Db } from "./db-types";

/**
 * Is this visit covered by a paid annual term? True only when an annual agreement on the visit's
 * series covers the visit's date (term_start ≤ date ≤ term_end) and that term actually started
 * (activated_at: paid online, renewed after payment, or started by the owner's own OK). Next
 * term's visits booked while a renewal is open, and hand-moved visits that survive a lapse, are
 * outside every paid term → invoiced as usual.
 */
export async function isPrepaidPlanVisit(organizationId: string, recurringJobId: string | null | undefined, visitDate: string | null | undefined, db?: unknown): Promise<boolean> {
  if (!recurringJobId || !visitDate || !/^\d{4}-\d{2}-\d{2}/.test(visitDate)) return false;
  const date = visitDate.slice(0, 10);
  try {
    const client = (db ?? createSupabaseAdminClient()) as Db;
    const { data, error } = await client
      .from("service_agreements")
      .select("id, term_start, term_end, activated_at")
      .eq("organization_id", organizationId)
      .eq("recurring_job_id", recurringJobId)
      .eq("billing", "annual")
      .not("activated_at", "is", null)
      .limit(50);
    if (error) return false;
    return ((data ?? []) as Array<{ term_start: string | null; term_end: string | null; activated_at: string | null }>).some(
      (a) => Boolean(a.activated_at && a.term_start && a.term_end && a.term_start <= date && date <= a.term_end),
    );
  } catch {
    return false;
  }
}

/**
 * invoices/reminders.ts: a plan invoice still waiting on the customer (sign-up / renewal, always
 * reminders-paused) never raises `invoice.overdue`. Only asked for paused invoices; any error →
 * false (the sweep behaves exactly as before).
 */
export async function isPendingPlanInvoice(db: unknown, organizationId: string, invoiceId: string): Promise<boolean> {
  try {
    const { data, error } = await (db as Db)
      .from("service_agreements")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("pending_invoice_id", invoiceId)
      .limit(1);
    if (error) return false;
    return ((data ?? []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}
