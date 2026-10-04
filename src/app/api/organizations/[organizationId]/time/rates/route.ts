import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { assertManager, listRates, rateSchema, setRate } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** What an hour of each team member costs (owners/admins only). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    assertManager(role);
    return NextResponse.json({ data: await listRates(ctx) });
  });
}

/** Set (or clear, with null) one person's hourly cost. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    assertManager(role);
    const input = await parseJsonBody(request, rateSchema);
    return NextResponse.json({ data: await setRate(ctx, input) });
  });
}
