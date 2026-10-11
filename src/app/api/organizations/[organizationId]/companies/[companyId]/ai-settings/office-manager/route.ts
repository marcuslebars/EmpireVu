import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { AuthorizationError, requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization, type TenantServiceContext } from "@/server/services/shared";
import { isBriefingTime } from "@/server/services/staff/office-manager/settings";
import { getOfficeManagerView, updateOfficeManager } from "@/server/services/staff/office-manager/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    time: z.string().refine(isBriefingTime, "Pick a time between 6:00 and 9:00 a.m.").optional(),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    emailCopy: z.boolean().optional(),
  })
  .strict();

async function guard(context: RouteContext, manage: boolean): Promise<{ organizationId: string; companyId: string }> {
  const supabase = createSupabaseServerClient();
  const organization = await requireOrganizationContext(supabase, context.params.organizationId);
  const role = organization.membership.role;
  if (manage && role !== "owner" && role !== "admin") {
    throw new AuthorizationError("Only owners and admins can change the morning briefing.");
  }
  const ctx: TenantServiceContext = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
  // The company must be this org's (checked on the caller's own RLS client) before any service-role call.
  await assertCompanyInOrganization(ctx, context.params.companyId);
  return { organizationId: organization.organizationId, companyId: context.params.companyId };
}

/** Settings → AI front desk → Office manager: the morning briefing settings and the last one sent (members read). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, false);
    const data = await getOfficeManagerView(createSupabaseAdminClient(), organizationId, companyId);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}

/** Owner/admin: merge ONLY ai_settings.office_manager. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guard(context, true);
    const patch = await parseJsonBody(request, patchSchema);
    const data = await updateOfficeManager(createSupabaseAdminClient(), organizationId, companyId, patch);
    if (!data) throw new UserFacingError("Company not found.", { status: 404 });
    return NextResponse.json({ data });
  });
}
