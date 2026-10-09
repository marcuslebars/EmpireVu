/**
 * POST /api/organizations/{org}/invoices/{invoiceId}/reminders/send
 * "Send reminder now": one reminder email to the customer right away. Doesn't use up a
 * scheduled reminder. 409 when the invoice can't take one (paid, no email, just sent).
 */
import { NextResponse } from "next/server";

import { invoiceRoute } from "@/server/api/invoice-route";
import { sendInvoiceReminderNow } from "@/server/services/invoices/reminders";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string };
}

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await sendInvoiceReminderNow(ctx, context.params.invoiceId) });
  });
}
