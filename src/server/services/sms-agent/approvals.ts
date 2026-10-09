/**
 * Asking the owner: owner_approvals rows the owner answers by text ("Y 2", "N 2", "Y but $700").
 * The SMS agent creates them; the owner channel notifies and decides; approved.ts executes.
 */
import type { AdminClient, ApprovalKind } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** How long each kind waits for the owner. Booking-slot holds go stale sooner. */
export function approvalTtlMs(kind: ApprovalKind): number {
  if (kind === "book_job") return 4 * 3_600_000;
  if (kind === "callback") return 12 * 3_600_000;
  return 24 * 3_600_000;
}

/** The smallest positive code not already used by the company's pending approvals. PURE. */
export function nextShortCode(used: Array<number | null>): number {
  const taken = new Set(used.filter((n): n is number => typeof n === "number"));
  let code = 1;
  while (taken.has(code)) code += 1;
  return code;
}

export interface NewApproval {
  organizationId: string;
  companyId: string;
  contactId: string | null;
  conversationId: string | null;
  kind: ApprovalKind;
  summary: string;
  payload: Record<string, unknown>;
}

export interface CreatedApproval {
  id: string;
  shortCode: number;
  expiresAt: string;
}

export interface ApprovalDeps {
  notify(admin: AdminClient, approvalId: string): Promise<{ notified: boolean }>;
  now(): Date;
}

export const defaultApprovalDeps: ApprovalDeps = {
  notify: notifyOwnerOfApproval,
  now: () => new Date(),
};

/**
 * Insert a pending approval with the next free short code (retrying on the unique index when
 * two are created at once), then ask the owner. The notify step is best-effort: the row is the
 * source of truth and the owner channel can re-send.
 */
export async function createApproval(
  admin: AdminClient,
  input: NewApproval,
  deps: ApprovalDeps = defaultApprovalDeps,
): Promise<CreatedApproval> {
  const db = admin as Db;
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + approvalTtlMs(input.kind)).toISOString();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: pending, error: readError } = await db
      .from("owner_approvals")
      .select("short_code")
      .eq("company_id", input.companyId)
      .eq("status", "pending");
    if (readError) throw readError;
    const shortCode = nextShortCode(((pending ?? []) as Array<{ short_code: number | null }>).map((r) => r.short_code));
    const { data, error } = await db
      .from("owner_approvals")
      .insert({
        organization_id: input.organizationId,
        company_id: input.companyId,
        contact_id: input.contactId,
        conversation_id: input.conversationId,
        kind: input.kind,
        summary: input.summary.slice(0, 500),
        payload: input.payload,
        status: "pending",
        short_code: shortCode,
        requested_by: "sms_agent",
        expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (error) {
      lastError = error;
      if ((error as { code?: string }).code === "23505") continue;
      throw error;
    }
    const id = (data as { id: string }).id;
    try {
      await deps.notify(admin, id);
    } catch (err) {
      console.error("[sms-agent] notifyOwnerOfApproval failed:", err instanceof Error ? err.message : err);
    }
    return { id, shortCode, expiresAt };
  }
  throw lastError ?? new Error("Could not allocate an approval code.");
}
