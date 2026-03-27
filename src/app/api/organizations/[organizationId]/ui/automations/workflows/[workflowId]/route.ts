import { NextResponse } from "next/server";

import { handleRoute, parseLimit, parsePage } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getWorkflowDetailView } from "@/server/services/live-data";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    workflowId: string;
  };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const data = await getWorkflowDetailView(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      context.params.workflowId,
      {
        page: parsePage(url.searchParams.get("page")),
        pageSize: parseLimit(url.searchParams.get("pageSize") ?? url.searchParams.get("limit")),
      },
      {
        companyId: url.searchParams.get("companyId"),
      },
    );

    return NextResponse.json({ data });
  });
}
