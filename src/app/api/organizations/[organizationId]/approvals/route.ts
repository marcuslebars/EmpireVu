import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listApprovalsForOrg } from "@/server/services/owner-channel/app";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Things the AI asked the owner to OK: pending + the last week's decisions (members read). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const companyId = new URL(request.url).searchParams.get("companyId");
    const data = await listApprovalsForOrg(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      { companyId: companyId && /^[0-9a-f-]{36}$/i.test(companyId) ? companyId : null },
    );
    return NextResponse.json({ data });
  }, request);
}
