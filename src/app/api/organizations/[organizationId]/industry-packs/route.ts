import { NextResponse } from "next/server";

import { assertCanManagePacks } from "@/server/organizations/admin";
import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listIndustryPacks } from "@/server/services/packs/apply";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * The industry starter packs (no prices — services, recipes, receptionist notes). With
 * `?companyId=`, also which pack the company has and which catalog items still need a price.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManagePacks(organization);
    const companyId = new URL(request.url).searchParams.get("companyId");

    const data = await listIndustryPacks(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
    );
    return NextResponse.json({ data });
  });
}
