import { NextResponse } from "next/server";

import type { Json } from "@/server/db/database.types";
import { logTelnyxPayload, verifyTelnyxSecret } from "@/server/services/telnyx/auth";
import {
  coerceBoolean,
  extractCallerNumber,
  extractCalledNumber,
  extractConversationId,
  normalizePhoneLast10,
  readString,
} from "@/server/services/telnyx/payload";
import { createTelnyxAdminClient, resolveTenantByCalledNumber } from "@/server/services/telnyx/tenant";

export const dynamic = "force-dynamic";

/**
 * Post-call Insights receiver.
 *
 * The Insights schema isn't confirmed yet, so the whole payload is stored
 * verbatim in `raw_payload` and the typed columns are best-effort reads —
 * nothing is lost if a field name differs.
 *
 * Upserts on `telnyx_conversation_id`, which is the same row the end-of-call
 * lead adapter stamps `lead_id` on. That both links the insight to its lead and
 * makes Telnyx retries idempotent. Processing is deliberately trivial so the
 * response stays fast.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyTelnyxSecret(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
    logTelnyxPayload("insights", payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const conversationId = extractConversationId(payload);
  if (!conversationId) {
    // Without the key there's nothing to upsert against. 200 so Telnyx doesn't
    // retry a payload that will never have one; the debug log keeps the body.
    return NextResponse.json({ data: { status: "ignored_missing_conversation_id" } });
  }

  try {
    const admin = createTelnyxAdminClient();
    const tenant = await resolveTenantByCalledNumber(admin, extractCalledNumber(payload));

    await admin.from("telnyx_call_insights").upsert(
      {
        booked: coerceBoolean(
          readString(payload, ["booked", "appointment_booked", "analysis.booked"]),
        ),
        call_outcome: readString(payload, [
          "call_outcome",
          "outcome",
          "analysis.call_outcome",
          "insights.outcome",
          "result",
        ]),
        caller_phone_last10: normalizePhoneLast10(extractCallerNumber(payload)),
        company_id: tenant.companyId,
        lead_quality: readString(payload, [
          "lead_quality",
          "quality",
          "analysis.lead_quality",
          "insights.lead_quality",
        ]),
        organization_id: tenant.organizationId,
        raw_payload: (payload ?? {}) as Json,
        requested_service: readString(payload, [
          "requested_service",
          "service",
          "service_type",
          "analysis.requested_service",
        ]),
        telnyx_conversation_id: conversationId,
      },
      { onConflict: "telnyx_conversation_id" },
    );

    return NextResponse.json({ data: { status: "ok" } });
  } catch (error) {
    console.error("[telnyx:insights] upsert failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Insights upsert failed." },
      { status: 500 },
    );
  }
}
