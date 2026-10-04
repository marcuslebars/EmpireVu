import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { getBusinessOverview, overviewQuerySchema } from "@/server/services/reports/overview";
import { assertManager } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Business overview for a date range: money in, owed, jobs, quotes, customers, crew (owners/admins only). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    assertManager(role);
    const url = new URL(request.url);
    const query = overviewQuerySchema.parse({
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
      companyId: url.searchParams.get("companyId") || null,
    });
    const data = await getBusinessOverview(ctx, { from: query.from ?? "", to: query.to ?? "", companyId: query.companyId ?? null });
    return NextResponse.json({ data });
  });
}
