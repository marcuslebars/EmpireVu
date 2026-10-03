import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { loadSetupChecklist } from "@/server/services/crankleads/setup-checklist";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * The CrankLeads setup checklist for the dashboard card ("Setup: 3 of 5 done → next step").
 * Normal RLS auth (org member). `data` is null for orgs that aren't CrankLeads purchases.
 * Same checklist the setup follow-up reminders use (services/crankleads/setup-checklist.ts).
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const checklist = await loadSetupChecklist(ctx);
    return NextResponse.json({ data: checklist });
  });
}
