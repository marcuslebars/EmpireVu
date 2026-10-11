import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { getImportOverview, updateImportSettings } from "@/server/services/staff/importer/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z.object({ enabled: z.boolean().optional() }).strict();

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  if (manage && role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can change customer import.");
  }
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId };
}

/** Settings → AI front desk → Customer import: the setting, recent imports, balances on hold (members read). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, false);
    const data = await getImportOverview(createSupabaseAdminClient(), organizationId, companyId);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.import. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateImportSettings(createSupabaseAdminClient(), organizationId, companyId, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
