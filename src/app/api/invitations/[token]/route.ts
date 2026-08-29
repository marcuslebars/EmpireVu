import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { ValidationError } from "@/server/organizations/context";
import { getInvitationByToken } from "@/server/services/organization-invitations";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: {
    token: string;
  };
}

// Public token lookup so the accept page can show who the invite is for before the
// invitee signs in. The token is the secret; no org membership is required.
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const admin = createSupabaseAdminClient();
    const data = await getInvitationByToken(admin, context.params.token);
    if (!data) {
      throw new ValidationError("This invitation link is invalid.");
    }
    return NextResponse.json({ data });
  });
}
