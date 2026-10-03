import { NextResponse } from "next/server";

import { invoiceRoute } from "@/server/api/invoice-route";
import { invoiceUpdateSchema } from "@/server/api/invoice-schemas";
import { getInvoiceDetail, updateInvoice } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await getInvoiceDetail(ctx, context.params.invoiceId) });
  });
}

/** Edit a draft or an unpaid sent invoice. Totals are always recomputed server-side. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const body = invoiceUpdateSchema.parse(await request.json().catch(() => ({})));
    const invoice = await updateInvoice(ctx, context.params.invoiceId, {
      ...body,
      lines: body.lines?.map((l) => ({
        label: l.label as string,
        description: l.description ?? null,
        quantity: l.quantity as number,
        unitPriceCents: l.unitPriceCents as number,
      })),
    });
    return NextResponse.json({ data: invoice });
  });
}
