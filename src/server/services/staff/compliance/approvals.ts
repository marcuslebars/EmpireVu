/**
 * Compliance's owner approvals (docs/ai-staff.md → "Compliance"):
 *
 *   request_sub_docs      a sub's document is running out (the expiry chase) or the owner asked
 *                         ("ask Mike's Electric for a new clearance"): Y texts (or emails) the sub
 *                         an upload link that works for 14 days
 *   share_compliance_doc  a customer / GC asked the texting assistant for the insurance
 *                         certificate (or WSIB clearance…): Y texts them a link to that one file
 *                         that works for 7 days
 *
 * Inserted through the shared path (front-desk/approvals.ts — short code at insert), then the
 * owner is asked: inline (an owner tool's reply IS the question → stamped notified_to) or via
 * notifyOwnerOfApproval (platform number; quiet hours 21:00–08:00 respected).
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";

export const REQUEST_SUB_DOCS_KIND = "request_sub_docs";
export const SHARE_DOC_KIND = "share_compliance_doc";
export const COMPLIANCE_KINDS_APPROVAL = [REQUEST_SUB_DOCS_KIND, SHARE_DOC_KIND] as const;

export const APPROVAL_TTL_MS: Record<string, number> = {
  [REQUEST_SUB_DOCS_KIND]: 72 * 3_600_000,
  [SHARE_DOC_KIND]: 24 * 3_600_000,
};

/** How long the links live once sent. */
export const UPLOAD_LINK_TTL_MS = 14 * 86_400_000;
export const SHARE_LINK_TTL_MS = 7 * 86_400_000;

export interface ComplianceApprovalInput {
  organizationId: string;
  companyId: string;
  contactId?: string | null;
  conversationId?: string | null;
  kind: (typeof COMPLIANCE_KINDS_APPROVAL)[number];
  summary: string;
  payload: Record<string, unknown>;
  /** The owner is being asked inline (owner tool reply): the phone that asked. */
  askedInlineTo?: string | null;
}

export async function createComplianceApproval(admin: AdminClient, input: ComplianceApprovalInput, nowMs: number): Promise<{ id: string; shortCode: number | null; summary: string }> {
  const now = new Date(nowMs);
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    conversationId: input.conversationId ?? null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    requestedBy: "compliance",
    createdAt: now,
    expiresAt: new Date(nowMs + (APPROVAL_TTL_MS[input.kind] ?? 24 * 3_600_000)),
    notifiedAt: input.askedInlineTo ? now : null,
    notifiedTo: input.askedInlineTo ?? null,
  });
  if (!input.askedInlineTo) {
    try {
      await notifyOwnerOfApproval(admin, row.id, { nowMs });
    } catch (err) {
      console.error("[compliance] notifyOwnerOfApproval failed:", err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code ?? null, summary: row.summary };
}

/** A pending approval of `kind` whose payload key matches (one open ask at a time). */
export async function pendingApproval(admin: AdminClient, companyId: string, kind: string, payloadKey: string, value: string): Promise<{ id: string; short_code: number | null } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("owner_approvals")
    .select("id, short_code")
    .eq("company_id", companyId)
    .eq("kind", kind)
    .eq("status", "pending")
    .eq(`payload->>${payloadKey}`, value)
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; short_code: number | null }>)[0] ?? null;
}
