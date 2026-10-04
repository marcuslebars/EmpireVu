import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { createRecurringJob, getRecurringJob, listRecurringJobs, recurringJobSchema } from "@/server/services/recurring/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Recurring jobs, active first. ?companyId to narrow. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const companyId = new URL(request.url).searchParams.get("companyId");
    return NextResponse.json({ data: await listRecurringJobs(ctx, { companyId }) });
  });
}

/** Create a series and put its first ~60 days of visits on the calendar. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const input = await parseJsonBody(request, recurringJobSchema);
    const { series, visitsCreated } = await createRecurringJob(ctx, input);
    return NextResponse.json({ data: { job: await getRecurringJob(ctx, series.id), visitsCreated } }, { status: 201 });
  });
}
