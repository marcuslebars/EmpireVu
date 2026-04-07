import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api/route";
import { createSupabaseServerClient } from "@/server/supabase/server";
import { getAuthenticatedUser } from "@/server/organizations/context";

export const dynamic = "force-dynamic";

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
}

interface MembershipRow {
  organization_id: string;
  organizations: OrganizationRow | null;
}

export async function GET(): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const user = await getAuthenticatedUser(supabase);

    const { data: memberships, error: membershipError } = await supabase
      .from("organization_memberships")
      .select(`
        organization_id,
        organizations (
          id,
          name,
          slug
        )
      `)
      .eq("profile_id", user.id);

    if (membershipError) {
      throw membershipError;
    }

    const organizations = (memberships as MembershipRow[] | null)
      ?.map((m) => m.organizations)
      .filter((org): org is OrganizationRow => org !== null) ?? [];

    return NextResponse.json({ data: organizations });
  });
}
