import { NextResponse } from "next/server";

import { handleRoute, parseLimit } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getConversationThread } from "@/server/services/inbox";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; contactId: string };
}

/** Keyset-paginated unified conversation thread for one contact (ui_conversation_thread). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const data = await getConversationThread(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      context.params.contactId,
      {
        beforeTs: url.searchParams.get("before"),
        limit: parseLimit(url.searchParams.get("limit")),
      },
    );

    return NextResponse.json({ data });
  });
}
