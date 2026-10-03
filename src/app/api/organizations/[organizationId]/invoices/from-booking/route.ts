import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { createInvoiceFromBooking } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const bodySchema = z.object({ bookingId: z.string().uuid() });

/** Booking → draft invoice (its quote's prices when it has one). 409 + existingInvoiceId if already invoiced. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const { bookingId } = bodySchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ data: await createInvoiceFromBooking(ctx, bookingId) }, { status: 201 });
  });
}
