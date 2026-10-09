import type { AdminClient } from "@/server/services/front-desk/contracts";

/**
 * Text the owner about a pending owner_approvals row ("Quote for Dana: $650. Reply Y to send,
 * N to skip"). Idempotent (notified_at). Respects the owner's quiet hours; urgent kinds may
 * bypass them. Must never throw.
 *
 * STUB — implemented by the owner channel part.
 */
export async function notifyOwnerOfApproval(_admin: AdminClient, _approvalId: string): Promise<{ notified: boolean }> {
  return { notified: false };
}
