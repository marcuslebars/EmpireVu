import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listCompanyConnectStatus } from "@/server/services/quotes/connect";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

/**
 * Member-authenticated read of every company's Stripe Connect status in the org —
 * powers the Payments settings page. RLS server client (a member reads their own
 * org's companies); the response carries no Stripe secrets, only capability flags.
 */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    await requireOrganizationContext(supabase, context.params.organizationId);

    const data = await listCompanyConnectStatus(supabase, context.params.organizationId);
    return NextResponse.json({ data });
  });
}
