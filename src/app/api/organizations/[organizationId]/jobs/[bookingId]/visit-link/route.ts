import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { getVisitLink } from "@/server/services/visits/settings";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** The customer's confirm / reschedule link for this job, and whether they've confirmed. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await getVisitLink(ctx, context.params.bookingId) }));
}
