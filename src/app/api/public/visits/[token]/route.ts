/** Public visit page data — GET /api/public/visits/{token}. The unguessable token is the credential. */
import { NextResponse } from "next/server";

import { visitPublicRoute } from "@/server/api/visit-public-route";
import { getVisit } from "@/server/services/visits/public";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return visitPublicRoute(request, context.params.token, { scope: "public_visit_view", limit: 120, windowSeconds: 600 }, async () =>
    NextResponse.json({ data: await getVisit(context.params.token) }),
  );
}
