import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseExpenseQuery } from "@/server/api/expense-route";
import { parseJsonBody } from "@/server/api/route";
import { expenseCreateSchema } from "@/server/services/expenses/rules";
import { createExpense, listExpenses } from "@/server/services/expenses/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

/** Expenses in a date range with totals. Crew see their own; owners/admins everyone's. */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    const data = await listExpenses(ctx, role, parseExpenseQuery(new URL(request.url)));
    return NextResponse.json({ data });
  });
}

/** Log an expense (optionally on a job, optionally with a receipt already uploaded). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    const input = await parseJsonBody(request, expenseCreateSchema);
    return NextResponse.json({ data: await createExpense(ctx, role, input) }, { status: 201 });
  });
}
