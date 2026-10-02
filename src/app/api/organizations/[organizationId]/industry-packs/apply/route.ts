import { NextResponse } from "next/server";
import { z } from "zod";

import { assertCanManagePacks } from "@/server/organizations/admin";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { requireFeature } from "@/server/services/billing/gating";
import { applyIndustryPack } from "@/server/services/packs/apply";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const applyBodySchema = z.object({
  companyId: z.string().uuid(),
  packId: z.string().min(1).max(80),
  services: z.boolean().optional(),
  recipes: z.union([z.literal("all"), z.literal("none"), z.array(z.string().min(1).max(80)).max(40)]).optional(),
  bookingPolicy: z.boolean().optional(),
});

/**
 * Apply an industry pack to a company. Idempotent: re-running creates nothing new, tailors
 * only recipes the owner hasn't edited, and returns a report (created / skipped / needs prices).
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManagePacks(organization);
    const body = await parseJsonBody(request, applyBodySchema);
    // Installing automations is the workflows feature — same gate as /workflows/recipes/install.
    if (body.recipes !== "none") await requireFeature(supabase, organization.organizationId, "workflows");

    const data = await applyIndustryPack(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      body.companyId,
      body.packId,
      { services: body.services, recipes: body.recipes, bookingPolicy: body.bookingPolicy },
    );
    return NextResponse.json({ data }, { status: 200 });
  });
}
