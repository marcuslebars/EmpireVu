import { NextResponse } from "next/server";

// SANCTIONED EXCEPTION (service role) — concierge console list. Operator-only
// (requireOperator → 404 for everyone else); see services/concierge/accounts.ts.
import { handleRoute } from "@/server/api/route";
import { listConciergeAccounts } from "@/server/services/concierge/accounts";
import { requireOperator } from "@/server/services/concierge/auth";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/** CrankLeads accounts, newest first, with setup state. */
export async function GET(request: Request): Promise<NextResponse> {
  return handleRoute(async () => {
    await requireOperator(request);
    const data = await listConciergeAccounts(createSupabaseAdminClient());
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, request);
}
