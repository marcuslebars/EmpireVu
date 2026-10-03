import { NextResponse } from "next/server";

import { invoiceRoute } from "@/server/api/invoice-route";
import { customerAccountSchema } from "@/server/api/invoice-schemas";
import { createCustomerAccount, listCustomerAccounts } from "@/server/services/invoices/accounts";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const url = new URL(request.url);
    const accounts = await listCustomerAccounts(ctx, {
      includeArchived: url.searchParams.get("archived") === "1",
      search: url.searchParams.get("q") ?? undefined,
    });
    return NextResponse.json({ data: accounts });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const body = customerAccountSchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ data: await createCustomerAccount(ctx, { ...body, name: body.name as string }) }, { status: 201 });
  });
}
