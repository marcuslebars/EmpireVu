import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { voidInvoice } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string };
}

const bodySchema = z.object({ reason: z.string().max(500).nullable().optional() });

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const { reason } = bodySchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ data: await voidInvoice(ctx, context.params.invoiceId, reason ?? null) });
  });
}
