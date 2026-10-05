import { NextResponse } from "next/server";

import { reviewRoute } from "@/server/api/review-route";
import { listQuerySchema, listReviewRequests } from "@/server/services/reviews/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Review requests (queued, sent, clicked, skipped) with stats, newest first. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return reviewRoute(context.params.organizationId, async (ctx) => {
    const url = new URL(request.url);
    const q = listQuerySchema.parse({
      companyId: url.searchParams.get("companyId") || null,
      days: url.searchParams.get("days") ?? undefined,
      status: url.searchParams.get("status") || null,
    });
    return NextResponse.json({ data: await listReviewRequests(ctx, q) });
  });
}
