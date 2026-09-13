import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { getAuthenticatedUser } from "@/server/organizations/context";
import { AccountDeletionBlocked, deleteAccount, deleteAccountSchema } from "@/server/services/account-deletion";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

/** Permanently delete the signed-in user's account. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const supabase = createSupabaseServerClient();
    const user = await getAuthenticatedUser(supabase);
    const input = await parseJsonBody(request, deleteAccountSchema);
    const data = await deleteAccount(createSupabaseAdminClient(), user.id, input);
    return NextResponse.json({ data });
  } catch (error) {
    // The app needs the reason code to decide between "transfer ownership" and "confirm".
    if (error instanceof AccountDeletionBlocked) {
      return NextResponse.json({ error: error.message, code: error.code, organizations: error.organizations }, { status: 409 });
    }
    return handleRoute(async () => {
      throw error;
    });
  }
}
