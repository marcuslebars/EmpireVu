import { NextResponse } from "next/server";
import { z } from "zod";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { startConnect } from "@/server/services/accounting/connections";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const bodySchema = z.object({ provider: z.enum(["quickbooks", "xero"]) });

/** Where to send the owner to sign in to QuickBooks / Xero (with a signed state). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    const { provider } = await parseJsonBody(request, bodySchema);
    return NextResponse.json({ data: await startConnect(ctx, role, context.params.companyId, provider) });
  });
}
