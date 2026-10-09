/**
 * The in-app Approvals list (pending + recent decisions) and its Approve / Skip buttons.
 *
 * SANCTIONED EXCEPTION (service role) for the DECIDE path only: owner_approvals is not
 * client-writable (20261009100000_front_desk_ai), so the route checks the caller is an owner/
 * admin of the organization (requireOrganizationContext + role) and then runs the same decide
 * path as a texted "Y"/"N" with a service-role client pinned to that organization id — the
 * approval is loaded with .eq("organization_id", <caller's org>), so an id from another org is
 * "not found". Listing reads through the caller's own RLS client.
 */
import { z } from "zod";

import type { Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { decideApproval, type DecideOutcome } from "./approvals";

export interface ApprovalView {
  id: string;
  companyId: string;
  companyName: string | null;
  contactId: string | null;
  kind: string;
  summary: string;
  status: string;
  shortCode: number | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decidedVia: string | null;
  resultMessage: string | null;
}

export interface ApprovalList {
  pending: ApprovalView[];
  recent: ApprovalView[];
}

type Row = Tables<"owner_approvals">;

function view(row: Row, names: Map<string, string>): ApprovalView {
  const result = row.result && typeof row.result === "object" && !Array.isArray(row.result) ? (row.result as Record<string, unknown>) : {};
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: names.get(row.company_id) ?? null,
    contactId: row.contact_id,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    shortCode: row.short_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedVia: row.decided_via,
    resultMessage: typeof result.message === "string" ? result.message : null,
  };
}

export async function listApprovalsForOrg(ctx: TenantServiceContext, options: { companyId?: string | null; nowMs?: number } = {}): Promise<ApprovalList> {
  const nowMs = options.nowMs ?? Date.now();
  let pendingQ = ctx.supabase.from("owner_approvals").select("*").eq("organization_id", ctx.organizationId).eq("status", "pending");
  let recentQ = ctx.supabase
    .from("owner_approvals")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .neq("status", "pending")
    .gte("updated_at", new Date(nowMs - 7 * 86_400_000).toISOString());
  if (options.companyId) {
    pendingQ = pendingQ.eq("company_id", options.companyId);
    recentQ = recentQ.eq("company_id", options.companyId);
  }
  const [pending, recent, companies] = await Promise.all([
    pendingQ.order("created_at", { ascending: false }).limit(50),
    recentQ.order("updated_at", { ascending: false }).limit(15),
    ctx.supabase.from("companies").select("id, name").eq("organization_id", ctx.organizationId),
  ]);
  if (pending.error) throw pending.error;
  if (recent.error) throw recent.error;
  const names = new Map(((companies.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  return {
    pending: ((pending.data ?? []) as Row[]).map((r) => view(r, names)),
    recent: ((recent.data ?? []) as Row[]).map((r) => view(r, names)),
  };
}

export const decideApprovalBodySchema = z.object({
  decision: z.enum(["approve", "skip"]),
  note: z.string().trim().max(500).nullish(),
});

export async function decideApprovalFromApp(
  ctx: TenantServiceContext,
  approvalId: string,
  body: z.infer<typeof decideApprovalBodySchema>,
): Promise<{ outcome: DecideOutcome; message: string; approval: ApprovalView | null }> {
  const admin = createSupabaseAdminClient();
  const decided = await decideApproval(
    admin,
    approvalId,
    { approved: body.decision === "approve", ownerNote: body.note ?? null, decidedVia: "app", decidedBy: ctx.actorProfileId ?? "app" },
    { organizationId: ctx.organizationId },
  );
  return { outcome: decided.outcome, message: decided.message, approval: decided.approval ? view(decided.approval, new Map()) : null };
}
