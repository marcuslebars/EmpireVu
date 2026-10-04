/** Public "request work" from the customer portal — POST /api/public/portal/{token}/request */
import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { portalRequestSchema, requestWork } from "@/server/services/portal/public";
import { enforceRateLimit } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const limited = await enforceRateLimit(request, { scope: "public_portal_request", limit: 5, windowSeconds: 3600, keyParts: [context.params.token] });
    if (limited) return limited;
    const input = await parseJsonBody(request, portalRequestSchema);
    const ok = await requestWork(context.params.token, input);
    if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ data: { ok: true } }, { status: 201 });
  });
}
