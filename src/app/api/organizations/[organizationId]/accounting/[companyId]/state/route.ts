import { NextResponse } from "next/server";
import { z } from "zod";

import { crewRoute } from "@/server/api/crew-route";
import { syncStateFor } from "@/server/services/accounting/connections";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

const querySchema = z.object({ type: z.enum(["invoice", "expense"]), id: z.string().uuid() });

/** Has this invoice / expense reached the accounting file? (null when not connected or not an owner/admin) */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const url = new URL(request.url);
    const q = querySchema.parse({ type: url.searchParams.get("type"), id: url.searchParams.get("id") });
    return NextResponse.json({ data: await syncStateFor(ctx, context.params.companyId, q.type, q.id) });
  });
}
