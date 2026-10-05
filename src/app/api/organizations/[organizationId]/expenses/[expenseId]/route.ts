import { NextResponse } from "next/server";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { expenseUpdateSchema } from "@/server/services/expenses/rules";
import { deleteExpense, getExpense, updateExpense } from "@/server/services/expenses/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; expenseId: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => NextResponse.json({ data: await getExpense(ctx, role, context.params.expenseId) }));
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    const input = await parseJsonBody(request, expenseUpdateSchema);
    return NextResponse.json({ data: await updateExpense(ctx, role, context.params.expenseId, input) });
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx, role) => {
    await deleteExpense(ctx, role, context.params.expenseId);
    return NextResponse.json({ data: { ok: true } });
  });
}
