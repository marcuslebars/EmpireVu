/** Open times this visit can move to — GET /api/public/visits/{token}/times */
import { NextResponse } from "next/server";

import { visitPublicRoute } from "@/server/api/visit-public-route";
import { getOpenTimes } from "@/server/services/visits/public";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return visitPublicRoute(request, context.params.token, { scope: "public_visit_times", limit: 60, windowSeconds: 600 }, async () =>
    NextResponse.json({ data: await getOpenTimes(context.params.token) }),
  );
}
