import { NextResponse } from "next/server";

import { handleRoute, parseLimit, parsePage } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getWorkflowJobsListView } from "@/server/services/live-data";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    const data = await getWorkflowJobsListView(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        companyId: url.searchParams.get("companyId"),
        page: parsePage(url.searchParams.get("page")),
        pageSize: parseLimit(url.searchParams.get("pageSize") ?? url.searchParams.get("limit")),
        recentFailuresOnly: url.searchParams.get("recentFailures") === "true",
        status: status as "pending" | "running" | "completed" | "failed" | null,
      },
    );

    return NextResponse.json({ data });
  });
}