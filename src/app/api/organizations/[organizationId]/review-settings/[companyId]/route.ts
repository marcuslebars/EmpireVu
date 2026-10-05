import { NextResponse } from "next/server";

import { reviewRoute } from "@/server/api/review-route";
import { getReviewSettings, updateReviewSettings, updateReviewSettingsSchema } from "@/server/services/reviews/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** A brand's review link and review-request settings. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return reviewRoute(context.params.organizationId, async (ctx) => NextResponse.json({ data: await getReviewSettings(ctx, context.params.companyId) }));
}

/** Owners and admins only. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return reviewRoute(
    context.params.organizationId,
    async (ctx) => {
      const body = updateReviewSettingsSchema.parse(await request.json().catch(() => ({})));
      return NextResponse.json({ data: await updateReviewSettings(ctx, context.params.companyId, body) });
    },
    { adminOnly: true },
  );
}
