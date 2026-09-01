import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext, ValidationError } from "@/server/organizations/context";
import { getQuotesConfig } from "@/server/services/quotes/config";
import {
  assertCanManagePayments,
  getCompanyConnectStatus,
  refreshConnectedAccount,
} from "@/server/services/quotes/connect";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
    companyId: string;
  };
}

/**
 * Pull the company's live capability state from Stripe and mirror it onto the
 * company row, then return the fresh status. The `account.updated` webhook keeps
 * this current on its own; this is the manual "check now" the operator can hit
 * mid-onboarding. Same org-scoped authorization gate as the onboarding route.
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

    // Only a connected account has anything to pull; an unconnected one just
    // echoes its current (not_connected) status.
    if (company.connected) {
      await refreshConnectedAccount(context.params.companyId);
    }

    const status = await getCompanyConnectStatus(
      supabase,
      context.params.organizationId,
      context.params.companyId,
    );
    return NextResponse.json({ data: status });
  });
}
