/**
 * Service plans' owner approvals (docs/ai-staff.md → "Service plans"):
 *
 *   plan_signup     a sign-up that needs the owner (per-visit plans, annual plans when the
 *                   business can't take card payments online, the owner's own enroll_customer):
 *                   Y starts the plan, books the visits and texts the customer
 *   plan_renewals   the weekly batch of plans ending in the next 30 days: Y texts each customer
 *                   their own renewal link
 *
 * Inserted through the shared path (front-desk/approvals.ts — short code at insert), then the owner
 * is asked inline (an owner tool's reply IS the question → stamped notified_to) or through
 * notifyOwnerOfApproval (platform number; quiet hours respected).
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";

export const PLAN_SIGNUP_KIND = "plan_signup";
export const PLAN_RENEWALS_KIND = "plan_renewals";
export const SERVICE_PLAN_KINDS = [PLAN_SIGNUP_KIND, PLAN_RENEWALS_KIND] as const;

export const APPROVAL_TTL_MS: Record<string, number> = {
  [PLAN_SIGNUP_KIND]: 48 * 3_600_000,
  [PLAN_RENEWALS_KIND]: 6 * 86_400_000,
};

export interface PlanApprovalInput {
  organizationId: string;
  companyId: string;
  contactId?: string | null;
  kind: (typeof SERVICE_PLAN_KINDS)[number];
  summary: string;
  payload: Record<string, unknown>;
  /** The owner is being asked inline (an owner tool reply / an executor re-ask): that phone. */
  askedInlineTo?: string | null;
}

export interface PlanApprovalDeps {
  notify(admin: AdminClient, approvalId: string, nowMs: number): Promise<{ notified: boolean }>;
}

export const defaultPlanApprovalDeps: PlanApprovalDeps = {
  notify: (admin, id, nowMs) => notifyOwnerOfApproval(admin, id, { nowMs }),
};

export async function createPlanApproval(
  admin: AdminClient,
  input: PlanApprovalInput,
  nowMs: number,
  deps: PlanApprovalDeps = defaultPlanApprovalDeps,
): Promise<{ id: string; shortCode: number | null; summary: string }> {
  const now = new Date(nowMs);
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    requestedBy: "service_plans",
    createdAt: now,
    expiresAt: new Date(nowMs + (APPROVAL_TTL_MS[input.kind] ?? 24 * 3_600_000)),
    notifiedAt: input.askedInlineTo ? now : null,
    notifiedTo: input.askedInlineTo ?? null,
  });
  if (!input.askedInlineTo) {
    try {
      await deps.notify(admin, row.id, nowMs);
    } catch (err) {
      console.error("[service-plans] notifyOwnerOfApproval failed:", err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code ?? null, summary: row.summary };
}

/** Withdraw an approval nobody should answer any more (its row couldn't be linked). */
export async function supersedeApproval(admin: AdminClient, approvalId: string): Promise<void> {
  await admin.from("owner_approvals").update({ status: "superseded" }).eq("id", approvalId).eq("status", "pending");
}

/** The phone a decision came from, when it came by text (to ask a follow-up inline). */
export function smsDecider(decision: { decidedVia: string; decidedBy: string }): string | null {
  return decision.decidedVia === "sms" && /^\+\d{8,15}$/.test(decision.decidedBy) ? decision.decidedBy : null;
}
