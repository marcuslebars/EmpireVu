/**
 * Does the owner's "Y 12 <words>" read as a note on this materials order? Used by
 * owner-channel/entry.ts before it treats the words as a decision: only a note that parses in full
 * against the order's own lines ("delivery", "no nails", "25 bundles shingles") counts. Anything
 * else ("ok delivered", "ok move Jones to Friday") goes down the old did-you-mean / command path.
 * Read-only, never throws. Imports nothing that reaches the registry.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, PurchaseOrderRow } from "./db-types";
import { parseOrderNote } from "./format";

export async function orderNoteFits(admin: AdminClient, approval: { id: string; company_id: string; payload: unknown }, note: string): Promise<boolean> {
  try {
    const payload = approval.payload && typeof approval.payload === "object" ? (approval.payload as Record<string, unknown>) : {};
    const poId = typeof payload.poId === "string" ? payload.poId : null;
    if (!poId) return false;
    const { data } = await (admin as Db)
      .from("purchase_orders")
      .select("id, status, approval_id, lines, fulfilment")
      .eq("company_id", approval.company_id)
      .eq("id", poId)
      .maybeSingle();
    const po = data as Pick<PurchaseOrderRow, "status" | "approval_id" | "lines" | "fulfilment"> | null;
    if (!po || po.status !== "draft" || po.approval_id !== approval.id) return false;
    const read = parseOrderNote(note, po.lines ?? [], po.fulfilment);
    return read.ok === true && read.understood > 0;
  } catch {
    return false;
  }
}
