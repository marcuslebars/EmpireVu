import { z } from "zod";

import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import { forwardingCallbackExternalId, FORWARDING_TEST_JOB_PROVIDER } from "@/server/services/twilio/forwarding-test";
import { createMissedCallAdminClient } from "@/server/services/twilio/missed-call";
import { verifyTwilioSignature } from "@/server/services/twilio/signature";
import { twilioSignedUrl } from "@/server/services/twilio/voice-config";
import { emptyTwiml, twimlResponse } from "@/server/services/twilio/voice-twiml";

export const dynamic = "force-dynamic";

const EVENTS = new Set(["status", "amd"]);

/**
 * Forwarding verification — Twilio callbacks for the OUTBOUND test call
 * (docs/missed-call-catcher.md → Forwarding verification):
 *   ?testId=<uuid>&event=status  final call status (completed / busy / no-answer / failed / canceled)
 *   ?testId=<uuid>&event=amd     async answering-machine detection (AnsweredBy)
 * The testId + event are in the URL WE gave Twilio, which X-Twilio-Signature covers, so they
 * can't be forged. Flow: verify signature (403) → DURABLE: inbound_webhook_jobs
 * (provider='twilio_forwarding_test', external_id=<event>:<CallSid>:<status>) → 200. The
 * worker (handleForwardingTestJob) records it and decides the outcome.
 */
export async function POST(request: Request): Promise<Response> {
  const backstop = await enforceWebhookBackstop(request, "twilio_forwarding_test");
  if (backstop) return backstop;

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const signature = request.headers.get("x-twilio-signature");
  if (!verifyTwilioSignature(twilioSignedUrl(request), params, signature, process.env.TWILIO_AUTH_TOKEN)) {
    return new Response("Invalid signature.", { status: 403 });
  }

  const query = new URL(request.url).searchParams;
  const testId = query.get("testId");
  const event = query.get("event") ?? "";
  const externalId = forwardingCallbackExternalId(event, params);
  if (!testId || !z.string().uuid().safeParse(testId).success || !EVENTS.has(event) || !externalId) {
    // Authentic but not ours to process — acknowledge so Twilio doesn't retry.
    return twimlResponse(emptyTwiml());
  }

  try {
    await enqueueInboundWebhookJob(createMissedCallAdminClient(), {
      provider: FORWARDING_TEST_JOB_PROVIDER,
      externalId,
      payload: { ...params, ForwardingTestId: testId, ForwardingTestEvent: event },
    });
  } catch (err) {
    console.error("[twilio-forwarding-test] durable enqueue failed:", err instanceof Error ? err.message : err);
    return new Response("Failed to persist webhook.", { status: 500 });
  }
  return twimlResponse(emptyTwiml());
}
