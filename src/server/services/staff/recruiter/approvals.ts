/**
 * The Recruiter's owner approvals (docs/ai-staff.md → "Hiring & payroll"):
 *
 *   payroll_period    the morning after a pay period ends: Y locks its hours and emails the CSV
 *                     ("Y 12 anyway" locks with open entries left as they are)
 *   job_post          the AI-drafted job post: Y publishes it on the company site
 *   interview_invite  from the daily applicant digest (or the owner's "invite Jo"): Y texts the
 *                     applicant to set up a call
 *
 * Inserted through the shared path (front-desk/approvals.ts — short code at insert), then the
 * owner is asked: inline (an owner tool's reply IS the question → stamped notified_to) or via
 * notifyOwnerOfApproval (platform number; quiet hours 21:00–08:00 respected).
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";

export const PAYROLL_PERIOD_KIND = "payroll_period";
export const JOB_POST_KIND = "job_post";
export const INTERVIEW_INVITE_KIND = "interview_invite";
export const RECRUITER_KINDS = [PAYROLL_PERIOD_KIND, JOB_POST_KIND, INTERVIEW_INVITE_KIND] as const;

/** The note that lets "Y 12 anyway" lock a period with open entries. */
export const ANYWAY_NOTE = "anyway";

export const APPROVAL_TTL_MS: Record<string, number> = {
  [PAYROLL_PERIOD_KIND]: 3 * 86_400_000,
  [JOB_POST_KIND]: 48 * 3_600_000,
  [INTERVIEW_INVITE_KIND]: 48 * 3_600_000,
};

export interface RecruiterApprovalInput {
  organizationId: string;
  companyId: string;
  contactId?: string | null;
  kind: (typeof RECRUITER_KINDS)[number];
  summary: string;
  payload: Record<string, unknown>;
  /** The owner is being asked inline (owner tool reply / executor re-ask): the phone that asked. */
  askedInlineTo?: string | null;
}

export interface RecruiterApprovalDeps {
  notify(admin: AdminClient, approvalId: string, nowMs: number): Promise<{ notified: boolean }>;
}

export const defaultRecruiterApprovalDeps: RecruiterApprovalDeps = {
  notify: (admin, id, nowMs) => notifyOwnerOfApproval(admin, id, { nowMs }),
};

export async function createRecruiterApproval(
  admin: AdminClient,
  input: RecruiterApprovalInput,
  nowMs: number,
  deps: RecruiterApprovalDeps = defaultRecruiterApprovalDeps,
): Promise<{ id: string; shortCode: number | null; summary: string }> {
  const now = new Date(nowMs);
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    requestedBy: "recruiter",
    createdAt: now,
    expiresAt: new Date(nowMs + (APPROVAL_TTL_MS[input.kind] ?? 24 * 3_600_000)),
    notifiedAt: input.askedInlineTo ? now : null,
    notifiedTo: input.askedInlineTo ?? null,
  });
  if (!input.askedInlineTo) {
    try {
      await deps.notify(admin, row.id, nowMs);
    } catch (err) {
      console.error("[recruiter] notifyOwnerOfApproval failed:", err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code ?? null, summary: row.summary };
}

/** Withdraw an approval nobody should answer any more (e.g. its row couldn't be linked). */
export async function supersedeApproval(admin: AdminClient, approvalId: string): Promise<void> {
  await admin.from("owner_approvals").update({ status: "superseded" }).eq("id", approvalId).eq("status", "pending");
}

/** The phone a decision came from, when it came by text (to ask a follow-up inline). */
export function smsDecider(decision: { decidedVia: string; decidedBy: string }): string | null {
  return decision.decidedVia === "sms" && /^\+\d{8,15}$/.test(decision.decidedBy) ? decision.decidedBy : null;
}
