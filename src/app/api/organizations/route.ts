import { NextResponse } from "next/server";
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { createSupabaseServerClient } from "@/server/supabase/server";
import { getAuthenticatedUser } from "@/server/organizations/context";
import { createOrganization, createOrganizationInputSchema } from "@/server/services/organizations";

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

export async function POST(request: Request): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const user = await getAuthenticatedUser(supabase);
    const input = await parseJsonBody(request, createOrganizationInputSchema);

    // profiles.id === auth.users.id, so the authenticated user id doubles as the profile id.
    const organization = await createOrganization(supabase, user.id, user.id, input);

    return NextResponse.json({ data: organization }, { status: 201 });
  });
}
