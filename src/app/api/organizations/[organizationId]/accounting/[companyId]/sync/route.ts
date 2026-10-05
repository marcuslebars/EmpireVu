import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { syncNow } from "@/server/services/accounting/connections";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** Retry failures and catch up anything missed; the worker pushes within about a minute. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => NextResponse.json({ data: await syncNow(ctx, role, context.params.companyId) }));
}
