import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { getAuthenticatedUser } from "@/server/organizations/context";
import { acceptInvitation } from "@/server/services/organization-invitations";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    token: string;
  };
}

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const user = await getAuthenticatedUser(supabase);
    // Membership insert bypasses RLS via the service role — the invitee is not yet a member.
    const admin = createSupabaseAdminClient();
    const data = await acceptInvitation(admin, {
      token: context.params.token,
      userEmail: user.email ?? null,
      userId: user.id,
    });
    return NextResponse.json({ data });
  });
}
