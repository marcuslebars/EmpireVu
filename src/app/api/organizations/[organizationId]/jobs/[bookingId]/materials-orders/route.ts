import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { jobSheetOrders } from "@/server/services/staff/purchasing/job-sheet";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; bookingId: string };
}

/** The job sheet's read-only materials block (docs/ai-staff.md → "Purchasing"): any member, their own RLS client. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await jobSheetOrders(ctx, context.params.bookingId) }));
}
