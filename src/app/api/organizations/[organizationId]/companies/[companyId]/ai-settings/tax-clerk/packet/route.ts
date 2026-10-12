import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { UserFacingError } from "@/server/errors";
import { emailPacketFromApp, getTaxClerkView } from "@/server/services/staff/tax-clerk/view";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { guardTaxClerk } from "@/server/services/staff/tax-clerk/route-guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** Owner/admin: email the HST packet for the period Settings shows, now (their own click). */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const { organizationId, companyId } = await guardTaxClerk(context.params, true);
    const admin = createSupabaseAdminClient();
    const result = await emailPacketFromApp(admin, { organizationId, companyId });
    if (result.status === "not_found") throw new UserFacingError(result.message, { status: 404 });
    if (result.status === "no_email") throw new UserFacingError(result.message, { status: 400 });
    if (result.status === "failed") throw new UserFacingError(result.message, { status: 502 });
    const data = await getTaxClerkView(admin, organizationId, companyId, { manage: true });
    return NextResponse.json({ data, result });
  });
}
