import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import { createTwilioAdminClient } from "@/server/services/twilio/inbound-sms";
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

  if (!verifyTwilioSignature(inboundSmsUrl(request), params, signature, process.env.TWILIO_AUTH_TOKEN)) {
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

/**
 * The exact URL Twilio signed. Twilio signs the URL configured on the number, which behind
 * a proxy is not request.url (scheme/host differ). Prefer an explicit TWILIO_INBOUND_SMS_URL;
 * else rebuild from APP_BASE_URL + the request path.
 */
function inboundSmsUrl(request: Request): string {
  const configured = process.env.TWILIO_INBOUND_SMS_URL?.trim();
  if (configured) return configured;
  const base = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const url = new URL(request.url);
  return base ? `${base}${url.pathname}${url.search}` : request.url;
}
