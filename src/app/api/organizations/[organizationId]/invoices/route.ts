import { NextResponse } from "next/server";

import { invoiceRoute } from "@/server/api/invoice-route";
import { invoiceCreateSchema } from "@/server/api/invoice-schemas";
import { createInvoice, listInvoices, type InvoiceListFilter } from "@/server/services/invoices/service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const FILTERS: InvoiceListFilter[] = ["all", "draft", "open", "overdue", "paid", "void"];

/** GET ?filter=open|overdue|paid|draft|void&companyId=&contactId=&customerAccountId=&quoteId=&bookingId= */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const url = new URL(request.url);
    const p = (k: string) => url.searchParams.get(k) || undefined;
    const filter = (p("filter") ?? "all") as InvoiceListFilter;
    const result = await listInvoices(ctx, {
      filter: FILTERS.includes(filter) ? filter : "all",
      companyId: p("companyId"),
      contactId: p("contactId"),
      customerAccountId: p("customerAccountId"),
      quoteId: p("quoteId"),
      bookingId: p("bookingId"),
      limit: Number.parseInt(p("limit") ?? "200", 10) || 200,
    });
    return NextResponse.json({ data: result.invoices, summary: result.summary });
  });
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return invoiceRoute(context.params.organizationId, async (ctx) => {
    const body = invoiceCreateSchema.parse(await request.json().catch(() => ({})));
    const invoice = await createInvoice(ctx, {
      ...body,
      lines: body.lines.map((l) => ({ label: l.label, description: l.description ?? null, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
    });
    return NextResponse.json({ data: invoice }, { status: 201 });
  });
}
