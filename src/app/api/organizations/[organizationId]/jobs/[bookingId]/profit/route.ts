import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { assertManager, jobProfit } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Revenue vs labour + materials for one job (owners/admins only). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    assertManager(role);
    return NextResponse.json({ data: await jobProfit(ctx, context.params.bookingId) });
  });
}
