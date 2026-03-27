import { NextResponse } from "next/server";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { createOrganization, createOrganizationInputSchema } from "@/server/services/organizations";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const { data: profile, error: profileError } = await (supabase.from("profiles") as any)
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    if (!profile) {
      return NextResponse.json({ error: "Profile not found." }, { status: 404 });
    }

    const input = await parseJsonBody(request, createOrganizationInputSchema);
    const data = await createOrganization(supabase, user.id, profile.id, input);

    return NextResponse.json({ data }, { status: 201 });
  });
}
