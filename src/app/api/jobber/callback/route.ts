import { NextResponse } from "next/server";

import { verifyState } from "@/server/services/jobber/connect";
import { exchangeCodeAndStore } from "@/server/services/jobber/oauth";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/** OAuth redirect target. Verifies the HMAC `state`, exchanges the code, stores tokens. */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const orgId = verifyState(url.searchParams.get("state"));

  if (!code || !orgId) {
    return NextResponse.json({ error: "Invalid OAuth callback (bad code or state)." }, { status: 400 });
  }

  try {
    await exchangeCodeAndStore(createSupabaseAdminClient(), orgId, code);
    return NextResponse.json({ ok: true, message: "Jobber connected. You can close this window." });
  } catch (err) {
    console.error("[jobber] OAuth callback failed:", err);
    return NextResponse.json({ error: "Could not complete the Jobber connection." }, { status: 502 });
  }
}
