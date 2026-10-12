/**
 * Lines for the Office manager's 07:00 briefing (docs/ai-staff.md → "Purchasing"): materials
 * that still need picking up (or haven't arrived) for jobs today or tomorrow, one short line each,
 * e.g. "Pick up materials at Home Depot Pro (Barrie) for Jones (PO-12)". [] when Purchasing is off
 * for the company (house orgs), when nothing is waiting, or when a read fails. Read-only.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { addDays, localDate, zonedInstant } from "@/server/services/booking-windows";
import type { Db, PurchaseOrderRow } from "./db-types";
import { BOOKING_COLUMNS, toJobs } from "./orders";
import { loadPurchasingCompany } from "./settings";
import { WAITING_STATUSES } from "./sweeps";

const MAX_ITEMS = 4;

/** One line for one PO. PURE. */
export function briefingLine(input: { poNumber: string; supplier: string | null; who: string; fulfilment: "pickup" | "delivery"; status: string; sentVia: string | null; when: "today" | "tomorrow" }): string {
  const at = input.supplier ? ` at ${input.supplier}` : "";
  const from = input.supplier ? ` from ${input.supplier}` : "";
  if (input.status === "approved" && input.sentVia === "owner_call_in") return `Call in materials${input.supplier ? ` to ${input.supplier}` : ""} for ${input.who} (${input.poNumber}) - job ${input.when}`;
  if (input.fulfilment === "delivery") return `Materials${from} for ${input.who} (${input.poNumber}) not delivered yet - job ${input.when}`;
  return `Pick up materials${at} for ${input.who} (${input.poNumber})${input.when === "today" ? " - job today" : ""}`;
}

export async function briefingItems(admin: AdminClient, scope: { organizationId: string; companyId: string }, localDateKey: string): Promise<string[]> {
  try {
    const company = await loadPurchasingCompany(admin, scope.organizationId, scope.companyId);
    if (!company || !company.active || !company.settings.enabled) return [];
    const db = admin as Db;
    const { data: pos, error } = await db
      .from("purchase_orders")
      .select("*")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .in("status", [...WAITING_STATUSES])
      .limit(200);
    if (error) throw error;
    const open = ((pos ?? []) as PurchaseOrderRow[]).filter((p) => p.booking_id);
    if (open.length === 0) return [];
    const start = zonedInstant(localDateKey, "00:00", company.timeZone).toISOString();
    const end = zonedInstant(addDays(localDateKey, 2), "00:00", company.timeZone).toISOString();
    const { data: bookings, error: bErr } = await db
      .from("bookings")
      .select(BOOKING_COLUMNS)
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .in("id", open.map((p) => p.booking_id))
      .in("status", ["pending", "confirmed"])
      .gte("scheduled_for", start)
      .lt("scheduled_for", end);
    if (bErr) throw bErr;
    const jobs = new Map((await toJobs(admin, company.organizationId, (bookings ?? []) as never)).map((j) => [j.bookingId, j]));
    const items: Array<{ at: string; line: string }> = [];
    for (const po of open) {
      const job = po.booking_id ? jobs.get(po.booking_id) : undefined;
      if (!job) continue;
      const when = localDate(new Date(job.scheduledFor), company.timeZone) === localDateKey ? "today" : "tomorrow";
      const who = job.lastName?.trim() || job.firstName?.trim() || job.title;
      items.push({ at: job.scheduledFor, line: briefingLine({ poNumber: po.po_number, supplier: po.supplier_name, who, fulfilment: po.fulfilment, status: po.status, sentVia: po.sent_via, when }) });
    }
    items.sort((a, b) => a.at.localeCompare(b.at));
    const lines = items.map((i) => i.line);
    return lines.length > MAX_ITEMS ? [...lines.slice(0, MAX_ITEMS - 1), `+${lines.length - (MAX_ITEMS - 1)} more materials orders - text "materials status"`] : lines;
  } catch (err) {
    console.error("[purchasing] briefing items failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
