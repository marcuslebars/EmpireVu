import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { requireOrganizationContext } from "@/server/organizations/context";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    organizationId: string;
  };
}

interface OpsProfile {
  id: string;
  email: string;
  fullName: string | null;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);

    type OrgMembershipRow = { profile_id: string };
    type ProfileRow = { id: string; email: string; full_name: string | null };

    const membershipsResult = await supabase
      .from("organization_memberships")
      .select("profile_id")
      .eq("organization_id", context.params.organizationId);

    const memberships = membershipsResult.data as OrgMembershipRow[] | null;
    const membershipsError = membershipsResult.error;

    if (membershipsError) {
      throw membershipsError;
    }

    const profileIds = memberships?.map((m: OrgMembershipRow) => m.profile_id) ?? [];

    if (profileIds.length === 0) {
      return NextResponse.json({ data: [] });
    }

    const profilesResult = await supabase
      .from("profiles")
      .select("id, email, full_name")
      .in("id", profileIds);

    const profiles = profilesResult.data as ProfileRow[] | null;
    const profilesError = profilesResult.error;

    if (profilesError) {
      throw profilesError;
    }

    const rows: OpsProfile[] = (profiles ?? []).map((p: ProfileRow) => ({
      id: p.id,
      email: p.email,
      fullName: p.full_name ?? null,
    }));

    return NextResponse.json({ data: rows });
  });
}
