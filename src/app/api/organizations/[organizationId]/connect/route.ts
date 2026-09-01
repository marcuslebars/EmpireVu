import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { assertCanManagePayments, listCompanyConnectStatus } from "@/server/services/quotes/connect";
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
    if (!getQuotesConfig().enabled) {
      return NextResponse.json({ error: "Payments are not enabled." }, { status: 404 });
    }
    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManagePayments(org.membership.role);

    const data = await listCompanyConnectStatus(supabase, context.params.organizationId);
    return NextResponse.json({ data });
  });
}
