import { NextResponse } from "next/server";
import { z } from "zod";

import { crewRoute } from "@/server/api/crew-route";
import { parseJsonBody } from "@/server/api/route";
import { createReceiptUpload } from "@/server/services/expenses/receipts";
import { RECEIPT_TYPES } from "@/server/services/expenses/rules";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const bodySchema = z.object({
  type: z.enum(RECEIPT_TYPES),
  /** The client's id for this receipt, so a retried upload reuses the same file. */
  receiptId: z.string().uuid().optional(),
});

/** A one-time signed upload URL for a receipt photo (JPEG) or PDF. */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return crewRoute(context.params.organizationId, async (ctx) => {
    const body = await parseJsonBody(request, bodySchema);
    return NextResponse.json({ data: await createReceiptUpload(ctx.organizationId, body.type, body.receiptId) });
  });
}
