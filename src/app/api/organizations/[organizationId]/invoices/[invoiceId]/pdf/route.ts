import { NextResponse } from "next/server";

import { invoiceRoute } from "@/server/api/invoice-route";
import { loadCompanyForInvoice } from "@/server/services/invoices/common";
import { buildInvoiceDocument } from "@/server/services/invoices/document";
import { InvoiceNotFoundError } from "@/server/services/invoices/errors";
import { renderInvoicePdf } from "@/server/services/invoices/pdf";
import { getInvoice } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string; invoiceId: string };
}

/** The PDF for staff — including drafts (a preview before sending). */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const invoice = await getInvoice(ctx, context.params.invoiceId);
    if (!invoice) throw new InvoiceNotFoundError();
    const company = await loadCompanyForInvoice(ctx.supabase, ctx.organizationId, invoice.company_id);
    const bytes = await renderInvoicePdf(buildInvoiceDocument(invoice, company));
    const name = `${(invoice.invoice_number ?? "draft-invoice").replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}
