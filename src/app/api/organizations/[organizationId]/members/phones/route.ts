import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { listMemberPhones } from "@/server/services/staff/dispatcher/member-phone";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Team cell numbers for crew texts: { [profileId]: "+17055550142" | null } (any member; pinned to the caller's org). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const organization = await requireOrganizationContext(createSupabaseServerClient(), context.params.organizationId);
    return NextResponse.json({ data: await listMemberPhones(createSupabaseAdminClient(), organization.organizationId) });
  });
}
