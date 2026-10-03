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
    // Rebuilt field by field: under the SPA's non-strict tsconfig zod infers every key
    // as optional, which wouldn't satisfy the service's required fields.
    const invoice = await createInvoice(ctx, {
      companyId: body.companyId as string,
      contactId: body.contactId,
      customerAccountId: body.customerAccountId,
      title: body.title,
      lines: body.lines.map((l) => ({
        label: l.label as string,
        description: l.description ?? null,
        quantity: l.quantity as number,
        unitPriceCents: l.unitPriceCents as number,
      })),
      taxRateBps: body.taxRateBps,
      creditCents: body.creditCents,
      dueDate: body.dueDate,
      paymentTermsDays: body.paymentTermsDays,
      notes: body.notes,
      internalNotes: body.internalNotes,
      billToAddress: body.billToAddress,
    });
    return NextResponse.json({ data: invoice }, { status: 201 });
  });
}
