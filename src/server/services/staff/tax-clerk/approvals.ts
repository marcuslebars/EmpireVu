/**
 * The Tax Clerk's one owner approval (docs/ai-staff.md → "Receipts & HST"):
 *
 *   accountant_packet  "Y emails the Q3 packet to <accountant>": the expenses CSV (receipt links,
 *                      30 days), the invoice list and a one-page summary with the CRA lines.
 *                      Asked with the 10-day HST reminder (notified normally) or by the owner's
 *                      "send the hst packet" (owner tool, asked inline).
 *
 * Inserted through the shared path (front-desk/approvals.ts — short code at insert).
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";

export const ACCOUNTANT_PACKET_KIND = "accountant_packet";
/** Long enough to answer before the due date (the reminder goes 10 days ahead). */
export const PACKET_TTL_MS = 9 * 86_400_000;

export interface TaxApprovalDeps {
  notify(admin: AdminClient, approvalId: string, nowMs: number): Promise<{ notified: boolean }>;
}

export const defaultTaxApprovalDeps: TaxApprovalDeps = {
  notify: (admin, id, nowMs) => notifyOwnerOfApproval(admin, id, { nowMs }),
};

export interface PacketPayload {
  frequency: string;
  periodStart: string;
  periodEnd: string;
  label: string;
  to: string;
  /** Who it goes to, in words ("your accountant" / "you"). */
  toWho: "accountant" | "owner" | "other";
}

export async function createPacketApproval(
  admin: AdminClient,
  input: { organizationId: string; companyId: string; summary: string; payload: PacketPayload; askedInlineTo?: string | null },
  nowMs: number,
  deps: TaxApprovalDeps = defaultTaxApprovalDeps,
): Promise<{ id: string; shortCode: number | null; summary: string }> {
  const now = new Date(nowMs);
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: null,
    kind: ACCOUNTANT_PACKET_KIND,
    summary: input.summary,
    payload: input.payload as unknown as Record<string, unknown>,
    requestedBy: "tax_clerk",
    createdAt: now,
    expiresAt: new Date(nowMs + PACKET_TTL_MS),
    notifiedAt: input.askedInlineTo ? now : null,
    notifiedTo: input.askedInlineTo ?? null,
  });
  if (!input.askedInlineTo) {
    try {
      await deps.notify(admin, row.id, nowMs);
    } catch (err) {
      console.error("[tax-clerk] notifyOwnerOfApproval failed:", err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code ?? null, summary: row.summary };
}
