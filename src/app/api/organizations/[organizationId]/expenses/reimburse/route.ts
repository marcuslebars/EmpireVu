import { NextResponse } from "next/server";
import { z } from "zod";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { setReimbursed } from "@/server/services/expenses/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const bodySchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), reimbursed: z.boolean().default(true) });

/** Mark out-of-pocket expenses as paid back (or undo). Owners/admins only. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(
    context.params.organizationId,
    async (ctx, role) => {
      const body = await parseJsonBody(request, bodySchema);
      return NextResponse.json({ data: { updated: await setReimbursed(ctx, role, body.ids, body.reimbursed) } });
    },
    { adminOnly: true, adminOnlyMessage: "Only owners and admins can mark expenses as paid back." },
  );
}
