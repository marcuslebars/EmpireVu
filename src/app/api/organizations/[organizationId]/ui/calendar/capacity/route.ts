import { NextResponse } from "next/server";

import { handleRoute, parseIsoDate } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getCapacityConflictSummary } from "@/server/services/live-data";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

function getDefaultRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = start.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setUTCDate(start.getUTCDate() - diff);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return {
    end: end.toISOString(),
    start: start.toISOString(),
  };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const url = new URL(request.url);
    const defaults = getDefaultRange();

    const data = await getCapacityConflictSummary(
      {
        actorProfileId: organization.user.id,
        organizationId: organization.organizationId,
        supabase,
      },
      {
        assignedUserId: url.searchParams.get("assignedUserId"),
        companyId: url.searchParams.get("companyId"),
        end: parseIsoDate(url.searchParams.get("end"), "end", defaults.end),
        start: parseIsoDate(url.searchParams.get("start"), "start", defaults.start),
      },
    );

    return NextResponse.json({ data });
  });
}