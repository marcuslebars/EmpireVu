import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";

/**
 * Runs an approval once the owner has decided. Approved → do it (send the quote, book the
 * job, send the reply…); rejected → tell the customer politely / hand the conversation over.
 * Called by the owner channel. Must be idempotent per approval id.
 *
 * STUB — implemented by the SMS agent part.
 */
export async function executeApprovedAction(
  _admin: AdminClient,
  approval: OwnerApprovalRow,
  _decision: ApprovalDecision,
): Promise<ExecuteResult> {
  return { ok: false, message: `Nothing set up to run "${approval.kind}" yet.` };
}
