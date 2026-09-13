import { NextResponse } from "next/server";

import { handleRoute, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getInboxList } from "@/server/services/inbox";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Org-level inbox list (ui_inbox_v) — one row per contact with a conversation. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const data = await getInboxList(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      {
        companyId: url.searchParams.get("companyId"),
        needsReply: url.searchParams.get("needsReply") === "true",
        search: url.searchParams.get("search"),
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    return NextResponse.json({ data });
  });
}
