import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { getAccountingStatus, settingsUpdateSchema, updateAccountingSettings } from "@/server/services/accounting/connections";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** The company's accounting connection, mapping and recent sync activity (owners/admins). */
export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => NextResponse.json({ data: await getAccountingStatus(ctx, role, context.params.companyId) }));
}

/** Save the account mapping / start date; queues anything from the start date not synced yet. */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    const input = await parseJsonBody(request, settingsUpdateSchema);
    return NextResponse.json({ data: await updateAccountingSettings(ctx, role, context.params.companyId, input) });
  });
}
