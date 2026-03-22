import type { Tables } from "@/server/db/database.types";
import type { TenantServiceContext } from "@/server/services/shared";
import type { SupportedWorkflowTriggerEventType } from "@/server/services/workflow-engine/types";

export interface MatchWorkflowsOptions {
  companyId?: string | null;
  triggerEventType: SupportedWorkflowTriggerEventType;
}

export async function matchActiveWorkflows(
  context: TenantServiceContext,
  options: MatchWorkflowsOptions,
): Promise<Tables<"workflows">[]> {
  let query = context.supabase
    .from("workflows")
    .select("*")
    .eq("organization_id", context.organizationId)
    .eq("status", "active")
    .eq("trigger_event", options.triggerEventType)
    .order("created_at", { ascending: true });

  if (options.companyId) {
    query = query.or(`company_id.is.null,company_id.eq.${options.companyId}`);
  } else {
    query = query.is("company_id", null);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data ?? [];
}