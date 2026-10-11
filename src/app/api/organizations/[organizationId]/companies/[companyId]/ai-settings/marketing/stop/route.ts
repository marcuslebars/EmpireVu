import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { stopMarketingCampaign } from "@/server/services/staff/marketer/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** Owner/admin: stop the active win-back campaign (queued texts are skipped; sent ones stay sent). */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const role = organization.membership.role;
    if (role !== "owner" && role !== "admin") throw new AuthorizationError("Only owners and admins can stop a campaign.");
    const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
    await assertCompanyInOrganization(ctx, context.params.companyId);
    const data = await stopMarketingCampaign(createSupabaseAdminClient(), { organizationId: organization.organizationId, companyId: context.params.companyId });
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data: { ...data, canManage: true } });
  });
}
