import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { AuthorizationError, requireOrganizationContext, type OrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

export interface WeeklyReportRouteContext {
  ctx: TenantServiceContext;
  organization: OrganizationContext;
}

/**
 * Org-admin guard for /api/organizations/[organizationId]/companies/[companyId]/ai-settings/*
 * (docs/front-desk-ai.md). Requires owner/admin (unless `manage: false`, for reads), and checks the company belongs to the org on
 * the caller's RLS client BEFORE the handler makes any service-role write.
 */
export function weeklyReportSettingsRoute(
  organizationId: string,
  companyId: string,
  run: (route: WeeklyReportRouteContext) => Promise<NextResponse>,
  options: { manage?: boolean } = { manage: true },
): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, organizationId);
    const role = organization.membership.role;
    if (options.manage !== false && role !== "owner" && role !== "admin") {
      throw new AuthorizationError("Only owners and admins can change the AI front desk settings.");
    }
    const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    await assertCompanyInOrganization(ctx, companyId);
    return run({ ctx, organization });
  });
}
