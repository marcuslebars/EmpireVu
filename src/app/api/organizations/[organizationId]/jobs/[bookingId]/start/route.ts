import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { getJobSheet, startJob } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Start work on the job. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    await startJob(ctx, context.params.bookingId);
    return NextResponse.json({ data: await getJobSheet(ctx, context.params.bookingId) });
  });
}
