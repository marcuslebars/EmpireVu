import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { ValidationError } from "@/server/organizations/context";
import { assertManager, profitReport } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Finished jobs in a window with revenue, cost and profit (owners/admins only). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    assertManager(role);
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new ValidationError("from and to are required dates.");
    const data = await profitReport(ctx, { from: new Date(from).toISOString(), to: new Date(to).toISOString(), companyId: url.searchParams.get("companyId") });
    return NextResponse.json({ data });
  });
}
