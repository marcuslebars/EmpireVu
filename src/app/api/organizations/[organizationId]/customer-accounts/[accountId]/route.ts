import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { customerAccountSchema } from "@/server/api/invoice-schemas";
import { getCustomerAccount, updateCustomerAccount } from "@/server/services/invoices/accounts";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; accountId: string };
}

const patchSchema = customerAccountSchema.partial().extend({ archived: z.boolean().optional() });

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await getCustomerAccount(ctx, context.params.accountId) });
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const body = patchSchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ data: await updateCustomerAccount(ctx, context.params.accountId, body) });
  });
}
