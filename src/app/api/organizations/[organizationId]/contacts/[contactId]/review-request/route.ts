import { NextResponse } from "next/server";

import { reviewRoute } from "@/server/api/review-route";
import { askForReview, askSchema, contactReviewStatus } from "@/server/services/reviews/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; contactId: string };
}

/** The customer's latest review request, and whether a review link is set. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return reviewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await contactReviewStatus(ctx, context.params.contactId) }));
}

/** Ask this customer for a review now. 409 asked_recently unless { force: true }. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return reviewRoute(context.params.organizationId, async (ctx) => {
    const body = askSchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ data: await askForReview(ctx, context.params.contactId, body) });
  });
}
