import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import { getWeeklyReportView } from "@/server/services/weekly-report/view";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Weekly front-desk report for one company (any org member; RLS client). Query:
 *   companyId (required), weeks = complete weeks to return (1–12, default 8),
 *   includeCurrent = "1" to prepend this week so far.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const params = new URL(request.url).searchParams;
    const companyId = params.get("companyId");
    if (!companyId || !UUID.test(companyId)) throw new ValidationError("companyId is required.");
    const weeks = Number(params.get("weeks") ?? 8);
    const data = await getWeeklyReportView(
      { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase },
      companyId,
      { weeks: Number.isFinite(weeks) ? weeks : 8, includeCurrent: params.get("includeCurrent") === "1" },
    );
    return NextResponse.json({ data });
  });
}
