import { NextResponse } from "next/server";

import { readRetellFunctionRequest } from "@/server/services/retell/functions";
import type { PhoneQuoteArgs } from "@/server/services/retell/tools/phone-quote";
import { runPhoneQuote } from "@/server/services/retell/tools/run-phone-quote";

export const dynamic = "force-dynamic";

/**
 * POST /api/retell/functions/quote — Marina's `quote_shrink_wrap` tool.
 *
 * Prices from the calling company's catalog, files the phone lead, and creates a real,
 * numbered quote. Always answers 200 with a `say` sentence for Marina (a 5xx only when
 * something unexpected escapes), so a pricing problem becomes a graceful callback promise
 * rather than dead air. Argument contract: docs/marina-tools.md.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await readRetellFunctionRequest<PhoneQuoteArgs>(request, "quote");
  if ("response" in guard) return guard.response;

  try {
    const result = await runPhoneQuote(guard.data);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("[retell:quote] unexpected failure:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        ok: false,
        reason: "error",
        say: "I hit a snag pricing that. Someone from the team will text you the number within the hour.",
      },
      { status: 500 },
    );
  }
}
