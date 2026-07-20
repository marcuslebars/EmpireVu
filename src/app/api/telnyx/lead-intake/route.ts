import { NextResponse } from "next/server";

import { logTelnyxPayload, verifyTelnyxSecret } from "@/server/services/telnyx/auth";
import { ingestTelnyxLead } from "@/server/services/telnyx/lead-adapter";

export const dynamic = "force-dynamic";

/**
 * End-of-call lead creation. A thin adapter only: the captured fields are mapped
 * onto the canonical lead envelope and pushed through the EXISTING intake path,
 * so dedup, brand routing, activity and notification all behave exactly as they
 * do for a web form. No intake logic is reimplemented here.
 *
 * Idempotent by telnyx_conversation_id — a Telnyx retry returns the original
 * lead instead of creating a duplicate.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyTelnyxSecret(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
    logTelnyxPayload("lead-intake", payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  try {
    const result = await ingestTelnyxLead(payload);
    return NextResponse.json({
      data: { duplicate: result.duplicate, lead_id: result.leadId, status: "ok" },
    });
  } catch (error) {
    // Intake only throws when the durable write itself failed, so a 5xx here is
    // correct: it tells Telnyx to retry rather than silently losing the lead.
    console.error("[telnyx:lead-intake] failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Lead intake failed." },
      { status: 500 },
    );
  }
}
