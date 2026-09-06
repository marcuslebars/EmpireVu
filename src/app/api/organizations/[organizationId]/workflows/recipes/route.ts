import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listRecipeCatalog } from "@/server/services/workflow-engine/recipes/install";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/**
 * The recipe catalog (Task 10), annotated for a company: what's already installed and what
 * needs a channel configured. Read-only — installing is the POST /recipes/install route.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);

    const data = await listRecipeCatalog(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      url.searchParams.get("companyId"),
    );

    return NextResponse.json({ data });
  });
}
