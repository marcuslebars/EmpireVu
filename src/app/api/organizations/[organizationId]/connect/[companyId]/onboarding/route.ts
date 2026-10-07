import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import {
  assertCanManagePayments,
  getCompanyConnectStatus,
  onboardingUrls,
  startConnectOnboarding,
} from "@/server/services/quotes/connect";
import { createSupabaseServerClient } from "@/server/supabase/server";
import { loadOrganizationBrand } from "@/server/services/platform-brand";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    companyId: string;
  };
}

/**
 * Start (or resume) Stripe Connect onboarding for one company and return a fresh,
 * single-use Account Link URL for the client to redirect to.
 *
 * Authorization boundary: startConnectOnboarding runs on the RLS-bypassing admin
 * client (it must, to write the connected-account id), so we FIRST confirm the
 * company belongs to this org via the member's RLS client. An unknown company id
 * is a 400, never a silent onboarding against someone else's company.
 */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    if (!getQuotesConfig().enabled) {
      return NextResponse.json({ error: "Payments are not enabled." }, { status: 404 });
    }
    const supabase = createSupabaseServerClient();
    const org = await requireOrganizationContext(supabase, context.params.organizationId);
    assertCanManagePayments(org.membership.role);

    const company = await getCompanyConnectStatus(
      supabase,
      context.params.organizationId,
      context.params.companyId,
    );
    if (!company) {
      throw new ValidationError("Unknown company for this organization.");
    }

    const link = await startConnectOnboarding(
      context.params.companyId,
      onboardingUrls(context.params.companyId, await loadOrganizationBrand(supabase, context.params.organizationId)),
    );
    return NextResponse.json({ data: { url: link.url } });
  });
}
