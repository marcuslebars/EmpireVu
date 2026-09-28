import { NextResponse } from "next/server";

import { readRetellFunctionRequest } from "@/server/services/retell/functions";
import { runDepositLink, type DepositLinkArgs } from "@/server/services/retell/tools/booking";

export const dynamic = "force-dynamic";

/**
 * POST /api/retell/functions/deposit-link — Marina's `send_deposit_link` tool.
 * Texts (and optionally emails) the quote's hosted page, where the caller approves and pays the deposit.
 * Always answers with a `say` sentence for Marina. Contract: docs/marina-tools.md.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await readRetellFunctionRequest<DepositLinkArgs>(request, "deposit-link");
  if ("response" in guard) return guard.response;

  try {
    return NextResponse.json(await runDepositLink(guard.data), { status: 200 });
  } catch (error) {
    console.error("[retell:deposit-link] unexpected failure:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, reason: "error", say: "The link didn't send just now, so I've noted the spot as held — the owner will text it to you within the hour." }, { status: 500 });
  }
}
