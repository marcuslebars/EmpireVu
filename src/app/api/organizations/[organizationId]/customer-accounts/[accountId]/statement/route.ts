import { NextResponse } from "next/server";
import { z } from "zod";

import { invoiceRoute } from "@/server/api/invoice-route";
import { assertCompanyInOrganization } from "@/server/services/shared";
import { InvoiceNotFoundError } from "@/server/services/invoices/errors";
import { sendStatementEmail } from "@/server/services/invoices/notify";
import { renderStatementPdf } from "@/server/services/invoices/pdf";
import { buildStatement } from "@/server/services/invoices/statement";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; accountId: string };
}

/** GET ?companyId= — the statement PDF (one brand's open invoices for this business). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const companyId = z.string().uuid().parse(new URL(request.url).searchParams.get("companyId"));
    await assertCompanyInOrganization(ctx, companyId);
    const st = await buildStatement(ctx.supabase, ctx.organizationId, context.params.accountId, companyId);
    if (!st) throw new InvoiceNotFoundError("Business account not found.");
    const bytes = await renderStatementPdf(st.statement);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="statement-${st.statement.statementDate}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}

const sendSchema = z.object({ companyId: z.string().uuid(), to: z.string().email().nullable().optional() });

/** POST { companyId, to? } — email the statement to the account's billing email (or `to`). */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const body = sendSchema.parse(await request.json().catch(() => ({})));
    await assertCompanyInOrganization(ctx, body.companyId);
    // Confirm the account is visible to this member under RLS before the service-role send.
    const { data } = await ctx.supabase
      .from("customer_accounts")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("id", context.params.accountId)
      .maybeSingle();
    if (!data) throw new InvoiceNotFoundError("Business account not found.");
    const outcome = await sendStatementEmail(ctx, { customerAccountId: context.params.accountId, companyId: body.companyId, to: body.to });
    return NextResponse.json({ data: outcome });
  });
}
