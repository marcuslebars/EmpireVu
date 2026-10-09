import { NextResponse } from "next/server";

import { readRetellFunctionRequest } from "@/server/services/retell/functions";
import { createRetellAdminClient } from "@/server/services/retell/tenant";
import { isVerifiedAnswerTenant, readAnswerMetadata } from "@/server/services/voice/ai-answer";
import { runUrgentAlert, type UrgentAlertArgs } from "@/server/services/voice/post-call";

export const dynamic = "force-dynamic";

const SAY_FALLBACK =
  "I'm flagging this as urgent for the team right now. If anyone is in danger, please hang up and call 9-1-1.";

/**
 * POST /api/retell/functions/urgent-alert — the AI's `alert_owner` tool on an AI-answered
 * catcher call (docs/front-desk-ai.md → "## Phone answering"). Texts (and emails) the owner
 * immediately while the caller is still on the line — once per call.
 *
 * Gate: the shared function secret (readRetellFunctionRequest). Tenant: ONLY the HMAC-verified
 * metadata we put on the call at registration (`call.metadata`, from Retell's trusted call
 * object — never the model's arguments). No verified tenant → a safe spoken answer, no alert.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await readRetellFunctionRequest<UrgentAlertArgs>(request, "urgent-alert");
  if ("response" in guard) return guard.response;

  const raw = guard.data.raw && typeof guard.data.raw === "object" ? (guard.data.raw as Record<string, unknown>) : {};
  const call = raw.call && typeof raw.call === "object" ? (raw.call as Record<string, unknown>) : {};
  const tenant = readAnswerMetadata(call.metadata);
  if (!isVerifiedAnswerTenant(tenant)) {
    return NextResponse.json({ ok: false, reason: "unsupported", say: SAY_FALLBACK }, { status: 200 });
  }

  try {
    const result = await runUrgentAlert(createRetellAdminClient(), {
      tenant,
      args: guard.data.args ?? {},
      fromNumber: guard.data.call.fromNumber,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("[retell:urgent-alert] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, reason: "error", say: SAY_FALLBACK }, { status: 200 });
  }
}
