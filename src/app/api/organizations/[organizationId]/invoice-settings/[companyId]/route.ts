import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { invoiceSettingsSchema } from "@/server/services/invoices/settings";
import { getCompanyInvoiceSettings, updateCompanyInvoiceSettings } from "@/server/services/invoices/settings-service";
import { assertCanManagePayments } from "@/server/services/quotes/connect";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; companyId: string };
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    return NextResponse.json({ data: await getCompanyInvoiceSettings(ctx, context.params.companyId) });
  });
}

const patchSchema = z.object({
  taxRegistrationNumber: z.string().max(60).nullable().optional(),
  businessAddress: z.string().max(1000).nullable().optional(),
  settings: invoiceSettingsSchema.partial().optional(),
});

/** Owners and admins only — this decides how the brand gets paid. */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx, org) => {
    assertCanManagePayments(org.membership.role);
    const body = patchSchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ data: await updateCompanyInvoiceSettings(ctx, context.params.companyId, body) });
  });
}
