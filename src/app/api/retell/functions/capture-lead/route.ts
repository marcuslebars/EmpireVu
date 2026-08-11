import { NextResponse } from "next/server";

import { logRetellPayload, verifyRetellFunctionSecret } from "@/server/services/retell/auth";
import { getRetellConfig } from "@/server/services/retell/config";
import { captureRetellLead } from "@/server/services/retell/lead-adapter";

export const dynamic = "force-dynamic";

/**
 * Optional mid-call custom function. Retell's agent can invoke this DURING a call to
 * capture a lead immediately (before call_analyzed), so a caller who hangs up early is
 * still recorded. Authenticated by a shared-secret header (tool calls don't carry the
 * webhook HMAC). Idempotent by call_id: the later call_analyzed enriches the same call
 * row instead of creating a second lead. Returns a compact result the agent can speak.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyRetellFunctionSecret(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const cfg = getRetellConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ success: false, message: "Lead capture is not enabled." }, { status: 200 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  logRetellPayload("capture-lead", payload);

  try {
    const result = await captureRetellLead(payload);
    return NextResponse.json({
      success: true,
      duplicate: result.duplicate,
      lead_id: result.leadId,
      message: "Thanks — I've saved your details and our team will follow up shortly.",
    });
  } catch (error) {
    // A 5xx tells Retell the tool failed, so the agent can apologize or retry.
    console.error("[retell:capture-lead] failed:", error);
    return NextResponse.json(
      { success: false, message: "Sorry, I couldn't save that just now." },
      { status: 500 },
    );
  }
}
