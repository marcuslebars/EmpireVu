import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { getSessionContext } from "@/server/services/session-context";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const data = await getSessionContext(supabase);

    return NextResponse.json({ data });
  });
}