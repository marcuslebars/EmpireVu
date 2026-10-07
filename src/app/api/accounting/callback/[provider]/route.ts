import { NextResponse } from "next/server";

import { UserFacingError } from "@/server/errors";
import { completeConnect } from "@/server/services/accounting/connections";
import { ProviderError } from "@/server/services/accounting/types";
import { getAppBaseUrl } from "@/server/services/ai";
import { configuredAppBaseUrlFor, loadOrganizationBrand } from "@/server/services/platform-brand";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { provider: string };
}

/**
 * QuickBooks / Xero send the owner back here after they approve. The signed `state`
 * (bound to the owner, company and provider, 15-minute expiry) is the only trust input;
 * the owner lands back on Settings → Accounting either way.
 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const url = new URL(request.url);
  let back = new URL(`${getAppBaseUrl() ?? url.origin}/settings`);
  back.searchParams.set("section", "accounting");
  const provider = context.params.provider;
  if (provider !== "quickbooks" && provider !== "xero") {
    back.searchParams.set("accounting_error", "Unknown accounting service.");
    return NextResponse.redirect(back, 303);
  }
  try {
    const { companyId, organizationId } = await completeConnect(provider, url.searchParams);
    // Back to the owner's own app host (the CrankLeads host for a CrankLeads org, once configured).
    const ownBase = configuredAppBaseUrlFor(await loadOrganizationBrand(createSupabaseAdminClient(), organizationId));
    if (ownBase) back = new URL(`${ownBase}/settings`);
    back.searchParams.set("section", "accounting");
    back.searchParams.set("accounting", "connected");
    back.searchParams.set("company", companyId);
  } catch (err) {
    // Only messages written for the owner go into the URL; a token-exchange or
    // database error is logged and replaced with a plain one.
    const message =
      err instanceof UserFacingError || err instanceof ProviderError
        ? err.message
        : "Couldn't finish connecting. Please try again — if it keeps happening, contact support.";
    console.error(`[accounting] ${provider} callback failed:`, err instanceof Error ? err.message : err);
    back.searchParams.set("accounting_error", message.slice(0, 200));
  }
  return NextResponse.redirect(back, 303);
}
