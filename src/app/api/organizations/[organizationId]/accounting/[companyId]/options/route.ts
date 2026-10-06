import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { getOptions } from "@/server/services/accounting/connections";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** Accounts, products/services and tax codes from the connected file, plus suggested choices. */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => NextResponse.json({ data: await getOptions(ctx, role, context.params.companyId) }));
}
