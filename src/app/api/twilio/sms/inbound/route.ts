import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import { createTwilioAdminClient } from "@/server/services/twilio/inbound-sms";
import { inboundSmsUrlCandidates } from "@/server/services/twilio/sms-signed-urls";
import { verifyTwilioSignature } from "@/server/services/twilio/signature";

export const dynamic = "force-dynamic";

/**
 * Twilio inbound-SMS webhook. Verifies X-Twilio-Signature (fail closed), then is
 * DURABLE-FIRST: it enqueues an inbound_webhook_jobs row (provider='twilio',
 * external_id=MessageSid) and ACKs with an empty TwiML `<Response/>`. The workflow-event
 * worker drains the queue and runs handleInboundSms later, so nothing is lost between the
 * 200 and processing, and a Twilio redelivery of the same MessageSid is a no-op (the
 * queue's unique (provider, external_id) constraint).
 */
export async function POST(request: Request): Promise<Response> {
  const backstop = await enforceWebhookBackstop(request, "twilio_sms_inbound");
  if (backstop) return backstop;

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const signature = request.headers.get("x-twilio-signature");

  const candidates = inboundSmsUrlCandidates(request);
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!candidates.some((url) => verifyTwilioSignature(url, params, signature, authToken))) {
    // No secrets logged: which URLs were tried and which number it was for, so a webhook
    // URL / auth-token mismatch is diagnosable from the logs.
    console.warn("[twilio] inbound SMS signature rejected", { to: params.To ?? null, tried: candidates });
    return new Response("Invalid signature.", { status: 403 });
  }

  const messageSid = params.MessageSid ?? params.SmsSid;
  if (!messageSid) {
    // Malformed but authentic — ACK so Twilio doesn't retry a request we can't key on.
    return twiml();
  }

  // Durable-first: enqueue, THEN ACK. A persist failure returns 500 so Twilio retries.
  try {
    await enqueueInboundWebhookJob(createTwilioAdminClient(), {
      provider: "twilio",
      externalId: messageSid,
      payload: params,
    });
  } catch (err) {
    console.error("[twilio] durable enqueue failed:", err);
    return new Response("Failed to persist webhook.", { status: 500 });
  }

  return twiml();
}

/** Empty TwiML — no auto-reply from us (STOP/START confirmations are Twilio's own). */
function twiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
