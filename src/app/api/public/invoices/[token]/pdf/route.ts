/**
 * Invoice PDF — GET /api/public/invoices/{token}/pdf
 * Same credential as the page (the token). Drafts are never exposed.
 */
import { NextResponse } from "next/server";

import { handleRoute } from "@/server/api/route";
import { getPublicInvoicePdf } from "@/server/services/invoices/public";
import { enforceRateLimit } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const limited = await enforceRateLimit(request, {
      scope: "public_invoice_pdf",
      limit: 30,
      windowSeconds: 600,
      keyParts: [context.params.token],
    });
    if (limited) return limited;

    const pdf = await getPublicInvoicePdf(context.params.token);
    if (!pdf) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new NextResponse(Buffer.from(pdf.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${pdf.filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}
