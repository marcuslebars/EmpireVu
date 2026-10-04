import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { ValidationError } from "@/server/organizations/context";
import { listJobs } from "@/server/services/crew/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/**
 * Jobs in a window. ?scope=mine (default) — jobs I'm on; ?scope=all — every job.
 * ?from / ?to ISO instants (default: 12h ago → 14 days), ?companyId, ?includeDone=true.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") === "all" ? "all" : "mine";
    const now = Date.now();
    const from = url.searchParams.get("from") ?? new Date(now - 12 * 3600_000).toISOString();
    const to = url.searchParams.get("to") ?? new Date(now + 14 * 86400_000).toISOString();
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new ValidationError("from / to must be dates.");
    const data = await listJobs(ctx, {
      scope,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      companyId: url.searchParams.get("companyId"),
      includeDone: url.searchParams.get("includeDone") === "true",
    });
    return NextResponse.json({ data });
  });
}
