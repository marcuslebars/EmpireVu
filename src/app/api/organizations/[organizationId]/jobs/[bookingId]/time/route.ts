import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { jobEntries } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Time logged on this job (yours, or everyone's for owners/admins). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await jobEntries(ctx, context.params.bookingId) }));
}
