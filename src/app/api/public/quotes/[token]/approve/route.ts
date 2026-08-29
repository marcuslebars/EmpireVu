/**
 * Approve + start checkout — POST /api/public/quotes/{token}/approve
 *
 * One call does both, deliberately: recording an approval and then failing to
 * hand back a payment link would leave the customer approved, charged nothing,
 * and staring at an error — the exact "wondering what happens next" this flow
 * exists to avoid.
 *
 * Both halves are idempotent, so a double-tap yields ONE approval and ONE
 * Checkout Session:
 *   • approveQuote returns the existing frozen approval if one exists;
 *   • createDepositCheckoutSession reuses an open session.
 *
 * The amounts charged come from the columns frozen at approval, recomputed
 * server-side from stored inputs — never from this request body.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute } from "@/server/api/route";
import { createDepositCheckoutSession, DepositCheckoutError } from "@/server/services/quotes/checkout";
import { CompanyStripeError } from "@/server/services/quotes/company-stripe";
import { getQuotesConfig } from "@/server/services/quotes/config";
import { approveQuote, QuoteApprovalError } from "@/server/services/quotes/public-service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { token: string };
}

const bodySchema = z.object({
  fullName: z.string().min(2).max(120),
  termsAccepted: z.literal(true),
  selected: z.array(z.string().min(1).max(120)).max(40).default([]),
});

/** Best-effort client IP from the proxy chain. Recorded with the approval. */
function clientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || null;
  return request.headers.get("x-real-ip");
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const cfg = getQuotesConfig();
    if (!cfg.enabled) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const token = context.params.token;

    let parsed: z.infer<typeof bodySchema>;
    try {
      parsed = bodySchema.parse(await request.json().catch(() => ({})));
    } catch {
      // Deliberately specific: these are the two things the form can get wrong,
      // and a customer needs to know which.
      return NextResponse.json(
        { error: "Please enter your full name and accept the terms." },
        { status: 400 },
      );
    }

    try {
      const quote = await approveQuote({
        token,
        fullName: parsed.fullName,
        termsAccepted: parsed.termsAccepted,
        selectedServiceIds: parsed.selected,
        ip: clientIp(request),
        userAgent: request.headers.get("user-agent"),
      });

      const checkout = await createDepositCheckoutSession(token, { baseUrl: cfg.publicBaseUrl });

      return NextResponse.json({
        data: {
          checkoutUrl: checkout.url,
          approvedByName: quote.approved_by_name,
          depositCents: quote.approved_deposit_cents,
          totalCents: quote.approved_total_cents,
        },
      });
    } catch (err) {
      if (err instanceof QuoteApprovalError) {
        const status = err.code === "not_found" ? 404 : err.code === "not_approvable" ? 409 : 400;
        return NextResponse.json({ error: err.message }, { status });
      }
      if (err instanceof DepositCheckoutError) {
        if (err.code === "already_paid") {
          return NextResponse.json({ error: "This deposit has already been paid." }, { status: 409 });
        }
        // The approval DID land; only the payment link failed. Say so, so the
        // customer doesn't think their approval was lost.
        console.error(`[quotes] approved ${token} but checkout failed (${err.code}):`, err.message);
        return NextResponse.json(
          { error: "Your approval was recorded, but we could not start payment. Please contact us." },
          { status: 502 },
        );
      }
      if (err instanceof CompanyStripeError) {
        // Misconfiguration — never leak which env var is missing to a customer.
        console.error(`[quotes] Stripe not configured for ${token} (${err.code}):`, err.message);
        return NextResponse.json(
          { error: "Your approval was recorded, but we could not start payment. Please contact us." },
          { status: 502 },
        );
      }
      throw err;
    }
  });
}
