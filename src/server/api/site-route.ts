import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { SiteNotFoundError } from "@/server/services/dfy/site-generator";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { createSupabaseServerClient } from "@/server/supabase/server";

export interface SiteRouteContext {
  ctx: TenantServiceContext;
  role: string;
  canManage: boolean;
}

/**
 * Owner routes for a company's generated site (Settings → Your website). Org membership is
 * required; `manage: true` additionally requires owner/admin. The company must belong to the
 * org (checked on the caller's RLS client) before any service-role call is made.
 */
export function siteRoute(
  organizationId: string,
  companyId: string,
  run: (route: SiteRouteContext) => Promise<NextResponse>,
  options: { manage?: boolean } = {},
): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, organizationId);
    const role = organization.membership.role;
    const canManage = role === "owner" || role === "admin";
    if (options.manage && !canManage) {
      throw new AuthorizationError("Only owners and admins can change the website.");
    }
    const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    await assertCompanyInOrganization(ctx, companyId);
    try {
      return await run({ ctx, role, canManage });
    } catch (error) {
      if (error instanceof SiteNotFoundError) throw new UserFacingError(error.message, { status: 404 });
      throw error;
    }
  });
}
