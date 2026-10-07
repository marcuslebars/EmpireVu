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
import { BANK_DEBIT_UNAVAILABLE_MESSAGE, InvoiceCheckoutError, createInvoiceCheckout } from "@/server/services/invoices/public";
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
      if (parsed.data.method === "bank_debit" && isStripeError(err)) {
        // Stripe refused the debit somewhere we didn't anticipate. The customer can
        // still pay another way — say so instead of showing an error page.
        console.error("[invoices/pay] bank debit failed at Stripe:", err instanceof Error ? err.message : err);
        return NextResponse.json({ error: BANK_DEBIT_UNAVAILABLE_MESSAGE, code: "method_unavailable" }, { status: 409 });
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
  }, request);
}

/** Errors thrown by the Stripe SDK carry a `type` like "StripeInvalidRequestError". */
function isStripeError(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("Stripe");
}
