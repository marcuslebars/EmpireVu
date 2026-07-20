import { NextResponse } from "next/server";

import { acceptRealtimeCall, readRealtimeConfig } from "@/server/outbound/openai-realtime";
import { verifyStandardWebhook } from "@/server/webhooks/standard-webhooks";

export const dynamic = "force-dynamic";

interface RealtimeWebhookEvent {
  data?: { call_id?: string };
  type?: string;
}

/**
 * Public webhook: OpenAI posts `realtime.call.incoming` when a call arrives on
 * the SIP trunk, and we accept it with the agent's session config.
 *
 * PUBLIC + UNAUTHENTICATED, so the signature check is the only gate — it runs
 * before the body is parsed or acted on, and every failure path returns without
 * touching anything. Nothing here reads or writes the database.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const config = readRealtimeConfig();
  if (!config) {
    return NextResponse.json(
      { error: "OpenAI realtime is not configured. Set OPENAI_API_KEY and OPENAI_WEBHOOK_SECRET." },
      { status: 503 },
    );
  }

  // Raw body — re-serializing JSON would change the bytes and break the HMAC.
  const payload = await request.text();

  const verified = verifyStandardWebhook({
    id: request.headers.get("webhook-id"),
    payload,
    secret: config.webhookSecret,
    signatureHeader: request.headers.get("webhook-signature"),
    timestamp: request.headers.get("webhook-timestamp"),
  });

  if (!verified) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  let event: RealtimeWebhookEvent;
  try {
    event = JSON.parse(payload) as RealtimeWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  // Acknowledge anything else so OpenAI doesn't retry events we don't handle.
  if (event.type !== "realtime.call.incoming") {
    return NextResponse.json({ data: { handled: false } });
  }

  const callId = event.data?.call_id;
  if (!callId) {
    return NextResponse.json({ error: "Missing call_id." }, { status: 400 });
  }

  try {
    await acceptRealtimeCall(callId, config);
  } catch (error) {
    // A 5xx tells OpenAI the accept failed; the caller just hears ringing stop.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to accept the call." },
      { status: 502 },
    );
  }

  return NextResponse.json({ data: { accepted: true, callId } });
}
