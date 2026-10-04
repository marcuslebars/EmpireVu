import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { getRecurringJob, recurringJobSchema, updateRecurringJob } from "@/server/services/recurring/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; recurringJobId: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await getRecurringJob(ctx, context.params.recurringJobId) });
  });
}

/** Replace the series. Upcoming visits nobody has touched are re-laid from the new rule. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const input = await parseJsonBody(request, recurringJobSchema);
    const { visitsCreated, visitsRemoved } = await updateRecurringJob(ctx, context.params.recurringJobId, input);
    return NextResponse.json({ data: { job: await getRecurringJob(ctx, context.params.recurringJobId), visitsCreated, visitsRemoved } });
  });
}
