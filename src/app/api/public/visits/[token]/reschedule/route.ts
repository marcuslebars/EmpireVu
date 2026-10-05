/** Move the visit to an offered open time — POST /api/public/visits/{token}/reschedule */
import { NextResponse } from "next/server";

import { parseJsonBody } from "@/server/api/route";
import { visitPublicRoute } from "@/server/api/visit-public-route";
import { rescheduleSchema, rescheduleVisit } from "@/server/services/visits/public";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return visitPublicRoute(request, context.params.token, { scope: "public_visit_change", limit: 10, windowSeconds: 3600 }, async () => {
    const input = await parseJsonBody(request, rescheduleSchema);
    return NextResponse.json({ data: await rescheduleVisit(context.params.token, input) });
  });
}
