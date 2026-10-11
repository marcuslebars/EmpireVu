import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { periodCsvFile } from "@/server/services/staff/recruiter/payroll";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string; periodId: string };
}

/** Owner/admin: any pay period's payroll CSV (computed fresh from the time entries; logged). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const role = organization.membership.role;
    if (role !== "owner" && role !== "admin") throw new AuthorizationError("Only owners and admins can download payroll.");
    const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    await assertCompanyInOrganization(ctx, context.params.companyId);
    if (!/^[0-9a-f-]{36}$/i.test(context.params.periodId)) throw new UserFacingError("Pay period not found.", { status: 404 });
    const file = await periodCsvFile(
      createSupabaseAdminClient(),
      { organizationId: organization.organizationId, companyId: context.params.companyId },
      context.params.periodId,
      organization.user.id,
    );
    if (!file) throw new UserFacingError("Pay period not found.", { status: 404 });
    return new NextResponse(file.csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename.replace(/[^a-z0-9._-]/gi, "-")}"`,
        "cache-control": "no-store",
      },
    });
  });
}
