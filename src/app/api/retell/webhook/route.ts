import { NextResponse } from "next/server";

import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { logRetellPayload } from "@/server/services/retell/auth";
import { getRetellConfig } from "@/server/services/retell/config";
import { persistRetellCallRaw } from "@/server/services/retell/lead-adapter";
import { readString } from "@/server/services/retell/payload";
import { verifyRetellSignature } from "@/server/services/retell/signature";
import { createRetellAdminClient } from "@/server/services/retell/tenant";

export const dynamic = "force-dynamic";

/**
 * Retell voice-receptionist webhook. Verifies the X-Retell-Signature HMAC, then is
 * DURABLE-FIRST: it persists the raw call into retell_calls and enqueues an
 * inbound_webhook_jobs row, and ACKs only after BOTH writes succeed. The
 * workflow-event worker drains the queue and runs ingestRetellCall later, so nothing
 * is lost between the 200 and processing. Only `call_analyzed` carries the transcript
 * + analysis we build a lead from; every other event is ACKed without work.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const cfg = getRetellConfig();
  const rawBody = await request.text();
  const signature = request.headers.get("x-retell-signature");

  if (!verifyRetellSignature(rawBody, signature, cfg.apiKey, cfg.toleranceMs)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  // Inert unless intake OR outbound is enabled (the worker re-checks the specific flag
  // in ingestRetellCall). Signature is verified first, so a flagged-off endpoint can't
  // be probed unauthenticated; a valid-but-disabled call is ACKed (no retry).
  if (!cfg.enabled && !cfg.outboundEnabled) {
    return NextResponse.json({ ok: true, disabled: true }, { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  logRetellPayload("webhook", payload);

  const event = readString(payload, ["event"]);
  if (event !== "call_analyzed") {
    return NextResponse.json({ ok: true, ignored: event ?? "unknown" }, { status: 200 });
  }

  // Durable-first: persist the raw call (retell_calls), then enqueue (inbound_webhook_jobs),
  // THEN ACK. If either write fails we do NOT ACK — return 500 so Retell retries.
  try {
    const admin = createRetellAdminClient();
    const callId = await persistRetellCallRaw(admin, payload);
    await enqueueInboundWebhookJob(admin, { provider: "retell", externalId: callId, payload });
  } catch (err) {
    console.error("[retell] durable enqueue failed:", err);
    return NextResponse.json({ error: "Failed to persist webhook." }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
