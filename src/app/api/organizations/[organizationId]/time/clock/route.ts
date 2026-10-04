import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { clockIn, clockInSchema, clockOut, getMyClock } from "@/server/services/time/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** My running clock, or null. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await getMyClock(ctx) }));
}

/** Clock in (to a job, or general time). Stops my running clock first. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const text = await request.text();
    const input = clockInSchema.parse(text ? JSON.parse(text) : {});
    return NextResponse.json({ data: await clockIn(ctx, input) }, { status: 201 });
  });
}

/** Clock out. */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await clockOut(ctx) }));
}
