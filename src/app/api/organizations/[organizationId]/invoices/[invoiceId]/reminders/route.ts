/**
 * PATCH /api/organizations/{org}/invoices/{invoiceId}/reminders  { paused: boolean }
 * Turn this one invoice's automatic overdue reminders off, or back on.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { setInvoiceRemindersPaused } from "@/server/services/invoices/reminders";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string };
}

const bodySchema = z.object({ paused: z.boolean() });

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const { paused } = bodySchema.parse(await request.json().catch(() => ({})));
    const invoice = await setInvoiceRemindersPaused(ctx, context.params.invoiceId, paused);
    return NextResponse.json({ data: { paused: invoice.reminders_paused } });
  });
}
