import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { getJobSheet, updateJob, updateJobSchema } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** The job sheet: customer, where, crew, checklist, field progress. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await getJobSheet(ctx, context.params.bookingId) });
  });
}

/** Edit where the job is and the notes for the crew. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const input = await parseJsonBody(request, updateJobSchema);
    await updateJob(ctx, context.params.bookingId, input);
    return NextResponse.json({ data: await getJobSheet(ctx, context.params.bookingId) });
  });
}
