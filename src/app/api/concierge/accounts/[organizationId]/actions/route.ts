import { NextResponse } from "next/server";
import { z } from "zod";

// SANCTIONED EXCEPTION (service role) — concierge console actions. Operator-only
// (requireOperator → 404 for everyone else). Each action is validated, scoped to the named
// org + its own company, and audited in operator_actions. See services/concierge/actions.ts.
import { handleRoute, parseJsonBody } from "@/server/api/route";
import { actionRequestSchema, listConciergeActions, runConciergeAction } from "@/server/services/concierge/actions";
import { ConciergeNotFoundError, requireOperator } from "@/server/services/concierge/auth";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** The registered actions (name + label). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    await requireOperator(request);
    if (!z.string().uuid().safeParse(context.params.organizationId).success) throw new ConciergeNotFoundError();
    return NextResponse.json({ data: listConciergeActions() });
  }, request);
}

/** Body: { action, companyId?, input }. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const operator = await requireOperator(request);
    if (!z.string().uuid().safeParse(context.params.organizationId).success) throw new ConciergeNotFoundError();
    const body = await parseJsonBody(request, actionRequestSchema);
    const data = await runConciergeAction(createSupabaseAdminClient(), operator, context.params.organizationId, body);
    return NextResponse.json({ data });
  }, request);
}
