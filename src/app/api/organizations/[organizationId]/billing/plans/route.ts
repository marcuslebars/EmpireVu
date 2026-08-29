import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listPlanPricing } from "@/server/services/billing/plans";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/**
 * Member-authenticated read of live plan pricing from Stripe (amount, currency,
 * interval, optional setup fee) plus each plan's feature matrix. Powers the
 * billing page's plan-comparison cards.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    await requireOrganizationContext(supabase, context.params.organizationId);
    const data = await listPlanPricing();
    return NextResponse.json({ data });
  });
}
