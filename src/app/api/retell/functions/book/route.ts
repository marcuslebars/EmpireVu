import { NextResponse } from "next/server";

import { readRetellFunctionRequest } from "@/server/services/retell/functions";
import { runBook, type BookArgs } from "@/server/services/retell/tools/booking";

export const dynamic = "force-dynamic";

/**
 * POST /api/retell/functions/book — Marina's `book_wrap_date` tool.
 * Books a window against a quote from this call's company. Idempotent per call + quote; a full or too-soon window comes back with alternatives.
 * Always answers with a `say` sentence for Marina. Contract: docs/marina-tools.md.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await readRetellFunctionRequest<BookArgs>(request, "book");
  if ("response" in guard) return guard.response;

  try {
    return NextResponse.json(await runBook(guard.data), { status: 200 });
  } catch (error) {
    console.error("[retell:book] unexpected failure:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, reason: "error", say: "The booking didn't save. The owner will call you within the hour to lock it in." }, { status: 500 });
  }
}
