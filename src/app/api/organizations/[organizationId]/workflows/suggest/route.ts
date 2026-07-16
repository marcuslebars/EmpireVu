import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { suggestWorkflows } from "@/server/services/ai-workflows";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/**
 * Claude reads the org's real state and proposes automations. Read-only —
 * suggestions are returned, never created. The owner creates the ones they want
 * through the existing POST /workflows.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    const data = await suggestWorkflows({
      actorProfileId: organization.user.id,
      organizationId: organization.organizationId,
      supabase,
    });

    return NextResponse.json({ data });
  });
}
