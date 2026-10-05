import { NextResponse } from "next/server";

import { completeConnect } from "@/server/services/accounting/connections";
import { getAppBaseUrl } from "@/server/services/ai";

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
  const base = getAppBaseUrl() ?? url.origin;
  const back = new URL(`${base}/settings`);
  back.searchParams.set("section", "accounting");
  const provider = context.params.provider;
  if (provider !== "quickbooks" && provider !== "xero") {
    back.searchParams.set("accounting_error", "Unknown accounting service.");
    return NextResponse.redirect(back, 303);
  }
  try {
    const { companyId } = await completeConnect(provider, url.searchParams);
    back.searchParams.set("accounting", "connected");
    back.searchParams.set("company", companyId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't finish connecting.";
    console.error(`[accounting] ${provider} callback failed:`, message);
    back.searchParams.set("accounting_error", message.slice(0, 200));
  }
  return NextResponse.redirect(back, 303);
}
