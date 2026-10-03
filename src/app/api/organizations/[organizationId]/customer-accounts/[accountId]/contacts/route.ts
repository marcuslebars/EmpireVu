import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { setContactAccount } from "@/server/services/invoices/accounts";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; accountId: string };
}

const bodySchema = z.object({ contactId: z.string().uuid(), linked: z.boolean().default(true) });

/** Link a contact to this business (linked: false unlinks it). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const { contactId, linked } = bodySchema.parse(await request.json().catch(() => ({})));
    await setContactAccount(ctx, contactId, linked ? context.params.accountId : null, { fromAccountId: context.params.accountId });
    return NextResponse.json({ data: { contactId, customerAccountId: linked ? context.params.accountId : null } });
  });
}
