/**
 * The one way an owner_approvals row is created (docs/front-desk-ai.md). Both the SMS agent
 * (sms-agent/approvals.ts createApproval: TTL per kind, urgency, then notify) and the owner
 * channel (owner-channel/approvals.ts createApproval: owner-command confirmations) call
 * insertApproval, so every row gets its short code at insert from one per-company sequence:
 * one more than the highest code the company used in the last 7 days, so a code is never
 * reused within a week — a stale "Y 4" can't approve a newer item that happens to get code 4.
 * Past MAX_SHORT_CODE it wraps to the smallest code unused for 7 days. Guarded by
 * owner_approvals_short_code_open_idx (a lost race retries).
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

export const MAX_SHORT_CODE = 999;
/** A code isn't handed out again for this long. */
export const SHORT_CODE_REUSE_MS = 7 * 86_400_000;

/**
 * The next code for a company, given every code it used in the last 7 days (and any still
 * pending): one more than the highest, wrapping past MAX_SHORT_CODE to the smallest unused one.
 * PURE.
 */
export function nextShortCode(used: Array<number | null>): number {
  const taken = new Set(used.filter((n): n is number => typeof n === "number" && n > 0));
  const highest = taken.size ? Math.max(...taken) : 0;
  if (highest < MAX_SHORT_CODE) return highest + 1;
  for (let code = 1; code <= MAX_SHORT_CODE; code++) if (!taken.has(code)) return code;
  return highest + 1;
}

/** Codes a company used recently (any status) or still has pending. */
export async function recentShortCodes(admin: AdminClient, companyId: string, now: Date): Promise<number[]> {
  const since = new Date(now.getTime() - SHORT_CODE_REUSE_MS).toISOString();
  const [{ data: recent, error: e1 }, { data: pending, error: e2 }] = await Promise.all([
    admin.from("owner_approvals").select("short_code").eq("company_id", companyId).gte("created_at", since).not("short_code", "is", null).limit(5000),
    admin.from("owner_approvals").select("short_code").eq("company_id", companyId).eq("status", "pending").limit(1000),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  return [...((recent ?? []) as Array<{ short_code: number | null }>), ...((pending ?? []) as Array<{ short_code: number | null }>)]
    .map((r) => r.short_code)
    .filter((c): c is number => typeof c === "number");
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
  /** The owner is being asked inline (an owner-command confirmation). */
  notifiedAt?: Date | null;
  /** The phone that was asked (approval replies by text only count from this phone). */
  notifiedTo?: string | null;
}

export async function insertApproval(admin: AdminClient, input: ApprovalInsert): Promise<ApprovalDbRow> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const shortCode = nextShortCode(await recentShortCodes(admin, input.companyId, input.createdAt));
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
        notified_to: input.notifiedAt ? input.notifiedTo ?? null : null,
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
