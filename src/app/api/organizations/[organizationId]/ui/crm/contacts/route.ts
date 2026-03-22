import { NextResponse } from "next/server";

import { handleRoute, parseLimit, parsePage } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getCRMContactsView } from "@/server/services/live-data";
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
    const nextAction = url.searchParams.get("nextAction");
    const stage = url.searchParams.get("stage");

    const data = await getCRMContactsView(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        companyId: url.searchParams.get("companyId"),
        nextAction: nextAction as "urgent" | "action" | "wait" | "done" | null,
        ownerProfileId: url.searchParams.get("ownerProfileId"),
        page: parsePage(url.searchParams.get("page")),
        pageSize: parseLimit(url.searchParams.get("pageSize") ?? url.searchParams.get("limit")),
        search: url.searchParams.get("search"),
        stage: stage as "lead" | "qualified" | "active" | "closed" | null,
      },
    );

    return NextResponse.json({ data });
  });
}