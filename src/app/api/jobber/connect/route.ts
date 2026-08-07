import { NextResponse } from "next/server";

import { getJobberConfig } from "@/server/services/jobber/config";
import { checkConnectKey, resolveA1OrganizationId, signState } from "@/server/services/jobber/connect";
import { buildAuthorizeUrl } from "@/server/services/jobber/oauth";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * One-time admin connect: redirects to Jobber's OAuth authorize screen. /api/* is
 * outside the session middleware, so this is guarded by ?key=<JOBBER_CONNECT_SECRET>.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  if (!checkConnectKey(url.searchParams.get("key"))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const cfg = getJobberConfig();
  if (!cfg.clientId || !process.env.JOBBER_CONNECT_SECRET) {
    return NextResponse.json({ error: "Jobber connect is not configured." }, { status: 503 });
  }

  const admin = createSupabaseAdminClient();
  const orgId = await resolveA1OrganizationId(admin);
  if (!orgId) {
    return NextResponse.json({ error: "A1 organization not found." }, { status: 500 });
  }

  return NextResponse.redirect(buildAuthorizeUrl(signState(orgId), cfg));
}
