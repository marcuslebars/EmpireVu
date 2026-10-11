import { NextResponse } from "next/server";

// SANCTIONED EXCEPTION (service role) — the concierge porting queue. Operator-only
// (requireOperator → 404 for everyone else); see staff/porting/operator.ts. Never returns the
// account number or PIN (those come only from the audited port_reveal_secrets action).
import { handleRoute } from "@/server/api/route";
import { requireOperator } from "@/server/services/concierge/auth";
import { listOperatorPorts } from "@/server/services/staff/porting/operator";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

/** Every open number port, ready ones first, with the Twilio form fields formatted. */
export async function GET(request: Request): Promise<NextResponse> {
  return handleRoute(async () => {
    await requireOperator(request);
    const data = await listOperatorPorts(createSupabaseAdminClient());
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, request);
}
