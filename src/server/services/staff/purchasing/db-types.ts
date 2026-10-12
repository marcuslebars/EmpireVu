/**
 * Local row types for the Purchasing tables (migration 20261013130000_staff_purchasing.sql) until
 * they are merged into database.types.ts. Queries use the `Db = any` cast, like the other roles.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type PoStatus = "draft" | "approved" | "sent" | "confirmed" | "ready" | "picked_up" | "delivered" | "cancelled";
export type Fulfilment = "pickup" | "delivery";
export type LineSource = "recipe" | "ai" | "owner";

export interface SupplierRow {
  id: string;
  organization_id: string;
  company_id: string;
  name: string;
  branch: string | null;
  email: string | null;
  phone: string | null;
  account_number: string | null;
  preferred: boolean;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MaterialRecipeRow {
  id: string;
  organization_id: string;
  company_id: string;
  service_catalog_item_id: string;
  label: string;
  qty_per_unit: number | string;
  unit: string | null;
  supplier_id: string | null;
  est_unit_cost_cents: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** One line of a purchase order (purchase_orders.lines jsonb). */
export interface PoLine {
  label: string;
  qty: number;
  unit: string | null;
  /** Estimated cost per unit (cents), null when unknown. Never sent to the supplier. */
  estUnitCostCents: number | null;
  source: LineSource;
  /** An AI estimate whose prices were dropped (over the cap) — check it. */
  capped?: boolean;
}

export interface PurchaseOrderRow {
  id: string;
  organization_id: string;
  company_id: string;
  booking_id: string | null;
  supplier_id: string | null;
  /** Snapshot of the supplier's name (+ branch) — crew can read the PO but not the suppliers table. */
  supplier_name: string | null;
  status: PoStatus;
  po_seq: number;
  po_number: string;
  needed_by: string | null;
  fulfilment: Fulfilment;
  lines: PoLine[];
  est_total_cents: number;
  /** recipe | ai | mixed | owner */
  basis: string;
  source: "auto" | "owner";
  approval_id: string | null;
  sent_at: string | null;
  sent_via: string | null;
  sent_to: string | null;
  send_error: string | null;
  reminder_sent_at: string | null;
  status_changed_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  /** The job's name and start when the order was made (kept if the booking is deleted; a move is noticed). */
  job_label: string | null;
  job_scheduled_for: string | null;
  /** The last job change the owner was told about ("moved:<iso>" / "cancelled"). */
  job_change_notice: string | null;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderDraftRow {
  id: string;
  organization_id: string;
  company_id: string;
  booking_id: string;
  /** working | asked | no_materials | failed | capped */
  outcome: string;
  attempts: number;
  purchase_order_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
