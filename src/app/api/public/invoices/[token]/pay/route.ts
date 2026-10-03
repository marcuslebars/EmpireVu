/**
 * Start paying an invoice online — POST /api/public/invoices/{token}/pay
 * Body: { method: "card" | "bank_debit" }
 *
 * Returns { url } — the brand's Stripe Checkout page for the outstanding balance.
 * The amount comes from the database, never from this request.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { InvoiceCheckoutError, createInvoiceCheckout } from "@/server/services/invoices/public";
import { CompanyStripeError } from "@/server/services/quotes/company-stripe";
import { enforceRateLimit } from "@/server/services/rate-limit";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const bodySchema = z.object({ method: z.enum(["card", "bank_debit"]).default("card") });

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const limited = await enforceRateLimit(request, {
      scope: "public_invoice_pay",
      limit: 20,
      windowSeconds: 600,
      keyParts: [context.params.token],
    });
    if (limited) return limited;

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: "Choose how you'd like to pay." }, { status: 400 });

    try {
      const { url } = await createInvoiceCheckout(context.params.token, parsed.data.method);
      return NextResponse.json({ data: { url } });
    } catch (err) {
      if (err instanceof InvoiceCheckoutError) {
        const status = err.code === "not_found" ? 404 : 409;
        return NextResponse.json({ error: err.message, code: err.code }, { status });
      }
      if (err instanceof CompanyStripeError) {
        // The brand hasn't finished Stripe setup — the customer can't fix that.
        console.error("[invoices/pay] brand cannot take payments:", err.message);
        return NextResponse.json(
          { error: "Online payment isn't available right now. Please use one of the other payment options, or contact us." },
          { status: 409 },
        );
      }
      throw err;
    }
  });
}
