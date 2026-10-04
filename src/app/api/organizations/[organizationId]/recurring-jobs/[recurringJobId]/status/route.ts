import { NextResponse } from "next/server";
import { z } from "zod";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { getRecurringJob, setRecurringStatus } from "@/server/services/recurring/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; recurringJobId: string };
}

const schema = z.object({ status: z.enum(["active", "paused", "ended"]) });

/** Pause / resume / end. Pausing or ending takes upcoming untouched visits off the calendar. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const { status } = await parseJsonBody(request, schema);
    const { visitsCreated, visitsRemoved } = await setRecurringStatus(ctx, context.params.recurringJobId, status);
    return NextResponse.json({ data: { job: await getRecurringJob(ctx, context.params.recurringJobId), visitsCreated, visitsRemoved } });
  });
}
