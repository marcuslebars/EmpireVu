import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import {
  createMissedCallAdminClient,
  VOICEMAIL_JOB_PROVIDER,
  voicemailExternalId,
} from "@/server/services/twilio/missed-call";
import { verifyTwilioSignature } from "@/server/services/twilio/signature";
import { sayVoice, twilioSignedUrl } from "@/server/services/twilio/voice-config";
import { buildVoicemailDoneTwiml, emptyTwiml, twimlResponse } from "@/server/services/twilio/voice-twiml";

export const dynamic = "force-dynamic";

/**
 * Missed-call catcher — voicemail callbacks (docs/missed-call-catcher.md). One route, three
 * Twilio requests (distinguished by the `event` query param we put in the TwiML, which is
 * part of the signed URL):
 *   ?event=action        the <Record> action (caller finished) → goodbye TwiML
 *   ?event=status        the recording-status callback (recording is ready)
 *   ?event=transcription the transcription callback (MISSED_CALL_TRANSCRIBE=true)
 * Each is signature-verified, then DURABLE-FIRST: enqueued into inbound_webhook_jobs
 * (provider='twilio_voicemail'; external_id = recording:<RecordingSid> — shared by the
 * action and the status callback, so whichever lands first is processed once — or
 * transcription:<TranscriptionSid>) before we answer. The worker's handleVoicemail stores
 * the recording on missed_calls and alerts the owner.
 */
export async function POST(request: Request): Promise<Response> {
  const backstop = await enforceWebhookBackstop(request, "twilio_voice_recording");
  if (backstop) return backstop;

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const signature = request.headers.get("x-twilio-signature");

  if (!verifyTwilioSignature(twilioSignedUrl(request), params, signature, process.env.TWILIO_AUTH_TOKEN)) {
    return new Response("Invalid signature.", { status: 403 });
  }

  const event = new URL(request.url).searchParams.get("event");
  const externalId = voicemailExternalId(params);

  if (externalId && params.CallSid) {
    try {
      await enqueueInboundWebhookJob(createMissedCallAdminClient(), {
        provider: VOICEMAIL_JOB_PROVIDER,
        externalId,
        payload: params,
      });
    } catch (err) {
      console.error("[twilio-voice] voicemail durable enqueue failed:", err instanceof Error ? err.message : err);
      // The action request still has to finish the call (the status callback carries the
      // same RecordingSid as a second chance). A callback gets a 500 so the failure shows
      // in Twilio's debugger and is retried where Twilio retries.
      if (event !== "action") return new Response("Failed to persist webhook.", { status: 500 });
    }
  }

  return twimlResponse(event === "action" ? buildVoicemailDoneTwiml(sayVoice()) : emptyTwiml());
}
