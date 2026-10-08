import { NextResponse } from "next/server";
import { z } from "zod";

// SANCTIONED EXCEPTION (service role) — concierge console detail for ONE org the operator
// named. Operator-only (requireOperator → 404 for everyone else); every read is filtered by
// that org (+ its own company). See services/concierge/accounts.ts.
import { handleRoute } from "@/server/api/route";
import { loadConciergeAccountDetail } from "@/server/services/concierge/accounts";
import { listConciergeActions } from "@/server/services/concierge/register-all";
import { ConciergeNotFoundError, requireOperator } from "@/server/services/concierge/auth";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const uuid = z.string().uuid();

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    await requireOperator(request);
    if (!uuid.safeParse(context.params.organizationId).success) throw new ConciergeNotFoundError();
    const companyId = new URL(request.url).searchParams.get("companyId");
    if (companyId && !uuid.safeParse(companyId).success) throw new ConciergeNotFoundError();
    const data = await loadConciergeAccountDetail(createSupabaseAdminClient(), context.params.organizationId, {
      companyId,
      actions: listConciergeActions(),
    });
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, request);
}
