import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { requireFeature } from "@/server/services/billing/gating";
import { installRecipes } from "@/server/services/workflow-engine/recipes/install";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const installRecipesBodySchema = z.object({
  companyId: z.string().uuid(),
  only: z.array(z.string().min(1).max(80)).min(1).optional(),
});

/**
 * Install proven recipes onto a company (Task 10). Idempotent by workflows.slug — recipes
 * already present are skipped, so re-running is safe. Recipes whose channel isn't configured
 * install as drafts with a disabled_reason.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    await requireFeature(supabase, organization.organizationId, "workflows");
    const body = await parseJsonBody(request, installRecipesBodySchema);

    const data = await installRecipes(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      body.companyId,
      { only: body.only },
    );

    return NextResponse.json({ data }, { status: 201 });
  });
}
