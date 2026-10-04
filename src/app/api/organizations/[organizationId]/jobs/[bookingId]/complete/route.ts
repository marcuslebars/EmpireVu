import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { completeJob, completeJobSchema, getJobSheet } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** Mark the job done. 409 while checklist items are open, unless { force: true }. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const text = await request.text();
    const input = completeJobSchema.parse(text ? JSON.parse(text) : {});
    await completeJob(ctx, context.params.bookingId, input);
    return NextResponse.json({ data: await getJobSheet(ctx, context.params.bookingId) });
  });
}
