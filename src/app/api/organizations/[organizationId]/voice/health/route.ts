import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { assertCompanyInOrganization } from "@/server/services/shared";
import { companyReceptionistHealth } from "@/server/services/retell/health";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/**
 * GET ?companyId=… — is this company's receptionist wired up? Env, price list, deposits,
 * booking windows, and for each Retell number: bound agent, published version, webhooks
 * and tool URLs. Member-scoped (RLS client); Retell is only read, never changed.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }
    await assertCompanyInOrganization(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
    );
    const data = await companyReceptionistHealth(supabase, organization.organizationId, companyId);
    return NextResponse.json({ data });
  });
}
