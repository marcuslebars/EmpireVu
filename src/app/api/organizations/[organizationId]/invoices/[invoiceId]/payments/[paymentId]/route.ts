import { NextResponse } from "next/server";

import { invoiceRoute } from "@/server/api/invoice-route";
import { removePayment } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string; paymentId: string };
}

/** Remove a staff-recorded payment entered by mistake (kept in the record as "removed"). */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await removePayment(ctx, context.params.invoiceId, context.params.paymentId) });
  });
}
