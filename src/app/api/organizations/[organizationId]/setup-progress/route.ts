import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { loadSetupProgressView } from "@/server/services/dfy/progress-view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * The "We're setting you up" view for a CrankLeads org (docs/done-for-you.md). Org member
 * (RLS reads). `data` is null for orgs that aren't CrankLeads purchases. The admin client is
 * used only to mint the company's one-tap forwarding token (dfy_progress is service-role
 * written), for the company the caller's own RLS read returned.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const data = await loadSetupProgressView(ctx, createSupabaseAdminClient());
    return NextResponse.json({ data });
  });
}
