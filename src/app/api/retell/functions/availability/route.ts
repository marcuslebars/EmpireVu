import { NextResponse } from "next/server";

import { readRetellFunctionRequest } from "@/server/services/retell/functions";
import { runAvailability, type AvailabilityArgs } from "@/server/services/retell/tools/booking";

export const dynamic = "force-dynamic";

/**
 * POST /api/retell/functions/availability — Marina's `check_availability` tool.
 * Up to three open windows for the calling company, nearest first, with ready-to-read labels.
 * Always answers with a `say` sentence for Marina. Contract: docs/marina-tools.md.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await readRetellFunctionRequest<AvailabilityArgs>(request, "availability");
  if ("response" in guard) return guard.response;

  try {
    return NextResponse.json(await runAvailability(guard.data), { status: 200 });
  } catch (error) {
    console.error("[retell:availability] unexpected failure:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, reason: "error", say: "I can't see the calendar right now — the owner will call you within the hour to set the date." }, { status: 500 });
  }
}
