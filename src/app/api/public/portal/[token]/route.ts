/**
 * Public customer portal — GET /api/public/portal/{token}
 *
 * Unauthenticated: the unguessable token IS the credential. Returns the narrowed
 * PortalView (no internal ids). One 404 for every miss.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { getPortal } from "@/server/services/portal/public";
import { enforceRateLimit } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const limited = await enforceRateLimit(request, { scope: "public_portal_view", limit: 120, windowSeconds: 600, keyParts: [context.params.token] });
    if (limited) return limited;
    const portal = await getPortal(context.params.token);
    if (!portal) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ data: portal }, { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
  });
}
