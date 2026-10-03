import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { createInvoiceFromQuote } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const bodySchema = z.object({ quoteId: z.string().uuid() });

/** Quote → draft invoice (approved lines, deposit credited). 409 + existingInvoiceId if already invoiced. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const { quoteId } = bodySchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ data: await createInvoiceFromQuote(ctx, quoteId) }, { status: 201 });
  });
}
