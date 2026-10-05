import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { disconnect } from "@/server/services/accounting/connections";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

/** Revoke the sign-in and stop syncing. Records already in the file stay there. */
export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    await disconnect(ctx, role, context.params.companyId);
    return NextResponse.json({ data: { ok: true } });
  });
}
