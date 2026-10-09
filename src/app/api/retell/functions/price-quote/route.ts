import { NextResponse } from "next/server";

import { readRetellFunctionRequest } from "@/server/services/retell/functions";
import { runPriceListQuote, type PriceListQuoteArgs } from "@/server/services/retell/tools/price-list-quote";

export const dynamic = "force-dynamic";

/**
 * POST /api/retell/functions/price-quote — the Front Desk receptionist's `quote_services` tool
 * for non-marine trades (docs/front-desk-ai.md → "## Phone answering"). Matches the caller's
 * services to the calling company's price list ONLY (asks when unsure, never invents a price),
 * creates + sends a real quote and texts the link. Always answers with a `say` sentence.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await readRetellFunctionRequest<PriceListQuoteArgs>(request, "price-quote");
  if ("response" in guard) return guard.response;

  try {
    return NextResponse.json(await runPriceListQuote(guard.data), { status: 200 });
  } catch (error) {
    console.error("[retell:price-quote] unexpected failure:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { ok: false, reason: "error", say: "I hit a snag pricing that. Someone from the team will text you the number shortly." },
      { status: 500 },
    );
  }
}
