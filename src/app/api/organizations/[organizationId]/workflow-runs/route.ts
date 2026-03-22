import { NextResponse } from "next/server";

import { handleRoute, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listWorkflowRuns } from "@/server/services/workflow-runs";
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

    const data = await listWorkflowRuns(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        companyId: url.searchParams.get("companyId"),
        limit: parseLimit(url.searchParams.get("limit")),
        status: url.searchParams.get("status") as "pending" | "running" | "completed" | "failed" | null,
        triggerEventId: url.searchParams.get("triggerEventId"),
        workflowId: url.searchParams.get("workflowId"),
      },
    );

    return NextResponse.json({ data });
  });
}