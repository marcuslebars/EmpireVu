import { NextResponse } from "next/server";
import { handleRoute } from "@/server/api/route";
import { createSupabaseServerClient } from "@/server/supabase/server";
import { getAuthenticatedUser } from "@/server/organizations/context";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const user = await getAuthenticatedUser(supabase);

    // Fetch organizations the user is a member of
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

    const organizations = memberships
      .map((m: any) => m.organizations)
      .filter(Boolean);

    return NextResponse.json({ data: organizations });
  });
}
