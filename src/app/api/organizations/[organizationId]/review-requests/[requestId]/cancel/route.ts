import { NextResponse } from "next/server";

import { reviewRoute } from "@/server/api/review-route";
import { cancelReviewRequest } from "@/server/services/reviews/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; requestId: string };
}

/** Don't send a queued review request. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return reviewRoute(context.params.organizationId, async (ctx) => {
    await cancelReviewRequest(ctx, context.params.requestId);
    return NextResponse.json({ data: { cancelled: true } });
  });
}
