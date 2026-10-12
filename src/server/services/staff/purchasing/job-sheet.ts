/**
 * The materials block on the crew's job sheet (read-only): what was ordered for this job, from
 * where, and whether it's been picked up / delivered. Read with the caller's own (RLS) client —
 * every member of the org may read purchase_orders; no costs and no account numbers are returned.
 */
import type { TenantServiceContext } from "@/server/services/shared";
import type { Db, Fulfilment, PurchaseOrderRow } from "./db-types";
import { lineText } from "./format";

export interface JobSheetOrder {
  poNumber: string;
  status: string;
  statusLabel: string;
  supplier: string | null;
  fulfilment: Fulfilment;
  neededBy: string | null;
  estimate: boolean;
  items: string[];
}

const LABELS: Record<string, string> = {
  approved: "Ordered",
  sent: "Ordered",
  confirmed: "Confirmed by supplier",
  ready: "Ready for pickup",
  picked_up: "Picked up",
  delivered: "Delivered",
};

export async function jobSheetOrders(ctx: TenantServiceContext, bookingId: string): Promise<JobSheetOrder[]> {
  const { data, error } = await (ctx.supabase as Db)
    .from("purchase_orders")
    .select("po_number, status, supplier_name, fulfilment, needed_by, lines, created_at")
    .eq("organization_id", ctx.organizationId)
    .eq("booking_id", bookingId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw error;
  // Drafts aren't shown: the owner hasn't said Y yet and the list may still change.
  const rows = ((data ?? []) as Array<Pick<PurchaseOrderRow, "po_number" | "status" | "supplier_name" | "fulfilment" | "needed_by" | "lines">>).filter((p) => p.status !== "draft");
  return rows.map((p) => ({
    poNumber: p.po_number,
    status: p.status,
    statusLabel: p.status === "ready" && p.fulfilment === "delivery" ? "Ready" : LABELS[p.status] ?? p.status,
    supplier: p.supplier_name,
    fulfilment: p.fulfilment,
    neededBy: p.needed_by,
    estimate: (p.lines ?? []).some((l) => l.source === "ai"),
    items: (p.lines ?? []).map(lineText),
  }));
}
