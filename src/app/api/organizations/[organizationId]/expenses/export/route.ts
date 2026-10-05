import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseExpenseQuery } from "@/server/api/expense-route";
import { exportExpensesCsv } from "@/server/services/expenses/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Expenses CSV for the bookkeeper: one row per expense, oldest first. Same filters as the list. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    const query = parseExpenseQuery(new URL(request.url));
    const csv = await exportExpensesCsv(ctx, role, query);
    return new NextResponse(csv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="expenses-${query.from}-to-${query.to}.csv"` },
    });
  });
}
