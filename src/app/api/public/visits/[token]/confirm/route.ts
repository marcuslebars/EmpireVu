/** "I'll be there" — POST /api/public/visits/{token}/confirm */
import { NextResponse } from "next/server";

import { visitPublicRoute } from "@/server/api/visit-public-route";
import { confirmVisit } from "@/server/services/visits/public";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return visitPublicRoute(request, context.params.token, { scope: "public_visit_change", limit: 10, windowSeconds: 3600 }, async () =>
    NextResponse.json({ data: await confirmVisit(context.params.token) }),
  );
}
