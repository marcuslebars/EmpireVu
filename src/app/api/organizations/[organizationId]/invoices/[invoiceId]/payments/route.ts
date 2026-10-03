import { NextResponse } from "next/server";

import { invoiceRoute } from "@/server/api/invoice-route";
import { recordPaymentSchema } from "@/server/api/invoice-schemas";
import { recordPayment } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string };
}

/** Record money received outside the pay page (e-Transfer, cheque, cash, terminal). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const body = recordPaymentSchema.parse(await request.json().catch(() => ({})));
    const result = await recordPayment(ctx, context.params.invoiceId, {
      amountCents: body.amountCents as number,
      method: body.method as NonNullable<typeof body.method>,
      receivedAt: body.receivedAt,
      reference: body.reference,
      notes: body.notes,
      sendReceipt: body.sendReceipt,
    });
    return NextResponse.json({ data: result.invoice, payment: result.payment, receipt: result.receipt }, { status: 201 });
  });
}
