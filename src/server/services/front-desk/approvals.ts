/**
 * The one way an owner_approvals row is created (docs/front-desk-ai.md). Both the SMS agent
 * (sms-agent/approvals.ts createApproval: TTL per kind, urgency, then notify) and the owner
 * channel (owner-channel/approvals.ts createApproval: owner-command confirmations) call
 * insertApproval, so every pending row gets its short code at insert — the lowest free 1..99
 * among the company's pending rows, guarded by owner_approvals_short_code_open_idx (a lost race
 * retries with the next free code).
 *
 * Status transitions after that have one owner each:
 *   pending → approved / rejected / expired (the decision)  owner-channel decideApproval / expireApproval
 *   approved / rejected / expired → executed / failed / rejected / expired + result (the outcome)
 *       sms-agent executeApprovedAction for the agent's kinds; the owner channel for owner_command
 *   → back to pending (owner must clarify, e.g. "Y but about 700")  executeApprovedAction
 */
import type { Tables } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import type { AdminClient, ApprovalKind } from "@/server/services/front-desk/contracts";

type ApprovalDbRow = Tables<"owner_approvals">;

export const MAX_SHORT_CODE = 99;

/** The smallest positive code not already used by the company's pending approvals. PURE. */
export function nextShortCode(used: Array<number | null>): number {
  const taken = new Set(used.filter((n): n is number => typeof n === "number"));
  let code = 1;
  while (taken.has(code) && code < MAX_SHORT_CODE) code += 1;
  return code;
}

export interface ApprovalInsert {
  organizationId: string;
  companyId: string;
  contactId?: string | null;
  conversationId?: string | null;
  kind: ApprovalKind;
  summary: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  createdAt: Date;
  expiresAt: Date;
  /** The owner is being asked inline (an owner-command "Reply Y to confirm"). */
  notifiedAt?: Date | null;
}

export async function insertApproval(admin: AdminClient, input: ApprovalInsert): Promise<ApprovalDbRow> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: pending, error: readError } = await admin
      .from("owner_approvals")
      .select("short_code")
      .eq("company_id", input.companyId)
      .eq("status", "pending");
    if (readError) throw readError;
    const shortCode = nextShortCode(((pending ?? []) as Array<{ short_code: number | null }>).map((r) => r.short_code));
    const { data, error } = await admin
      .from("owner_approvals")
      .insert({
        organization_id: input.organizationId,
        company_id: input.companyId,
        contact_id: input.contactId ?? null,
        conversation_id: input.conversationId ?? null,
        kind: input.kind,
        summary: input.summary.slice(0, 500),
        payload: toJson(input.payload),
        status: "pending",
        short_code: shortCode,
        requested_by: input.requestedBy,
        created_at: input.createdAt.toISOString(),
        expires_at: input.expiresAt.toISOString(),
        notified_at: input.notifiedAt ? input.notifiedAt.toISOString() : null,
      })
      .select("*")
      .single();
    if (error) {
      lastError = error;
      if ((error as { code?: string }).code === "23505") continue;
      throw error;
    }
    return data as ApprovalDbRow;
  }
  throw lastError ?? new Error("Could not allocate an approval code.");
}
