import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { sendInvoice } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string };
}

const bodySchema = z.object({ email: z.boolean().optional(), sms: z.boolean().optional() });

/**
 * Issue (or re-send) an invoice. 200 whenever the invoice is issued — the email /
 * text outcomes ride alongside, so "sent, but not emailed because…" is reportable.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const opts = bodySchema.parse(await request.json().catch(() => ({})));
    const result = await sendInvoice(ctx, context.params.invoiceId, opts);
    return NextResponse.json({ data: result.invoice, email: result.email, sms: result.sms, publicUrl: result.publicUrl });
  });
}
