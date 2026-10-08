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
 * used only to mint / read the company's one-tap forwarding and quick-setup tokens (not
 * client-readable), for the company the caller's own RLS read returned — and those links are
 * returned to owners/admins only; members get the status.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    // The no-login setup / forwarding links are credentials: owners and admins only.
    const role = organization.membership.role;
    const data = await loadSetupProgressView(ctx, createSupabaseAdminClient(), { canSeeLinks: role === "owner" || role === "admin" });
    return NextResponse.json({ data });
  });
}
