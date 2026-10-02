import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import {
  createMissedCallAdminClient,
  resolveCatcherTenant,
  VOICE_JOB_PROVIDER,
  type CatcherTenant,
} from "@/server/services/twilio/missed-call";
import { verifyTwilioSignature } from "@/server/services/twilio/signature";
import {
  callbackBaseUrl,
  sayVoice,
  transcriptionEnabled,
  twilioSignedUrl,
  VOICE_RECORDING_PATH,
  voicemailMaxSecondsSetting,
} from "@/server/services/twilio/voice-config";
import {
  buildCatcherGreetingTwiml,
  emptyTwiml,
  twimlResponse,
  voicemailMaxSeconds,
} from "@/server/services/twilio/voice-twiml";

export const dynamic = "force-dynamic";

/**
 * Missed-call catcher — Twilio inbound VOICE webhook (docs/missed-call-catcher.md).
 *
 * The business forwards unanswered calls (carrier conditional forwarding) to a catcher
 * number whose Voice URL is this route, so every call here is a missed call. Flow:
 *   1) verify X-Twilio-Signature (fail closed → 403);
 *   2) DURABLE-FIRST: enqueue the raw params into inbound_webhook_jobs
 *      (provider='twilio_voice', external_id=CallSid) — a redelivery is a no-op; a persist
 *      failure returns 500 (Twilio then plays its error / uses the number's fallback URL);
 *   3) resolve the tenant by the CALLED number (voice_numbers, provider='twilio',
 *      mode='missed_call_catcher') only to say the company's name: unknown number → empty
 *      <Response/> (the job stays stored for ops); a lookup error → generic greeting;
 *   4) answer with TwiML: greeting + <Record> voicemail (recording/transcription callbacks
 *      go to /api/twilio/voice/recording).
 * The lead, call.missed and text-back happen in the worker (handleMissedCall).
 */
export async function POST(request: Request): Promise<Response> {
  const backstop = await enforceWebhookBackstop(request, "twilio_voice_inbound");
  if (backstop) return backstop;

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const signature = request.headers.get("x-twilio-signature");

  if (!verifyTwilioSignature(twilioSignedUrl(request), params, signature, process.env.TWILIO_AUTH_TOKEN)) {
    return new Response("Invalid signature.", { status: 403 });
  }

  const callSid = params.CallSid;
  if (!callSid) {
    // Authentic but un-keyable — nothing to persist against; hang up cleanly.
    return twimlResponse(emptyTwiml());
  }

  const admin = createMissedCallAdminClient();
  try {
    await enqueueInboundWebhookJob(admin, { provider: VOICE_JOB_PROVIDER, externalId: callSid, payload: params });
  } catch (err) {
    console.error("[twilio-voice] durable enqueue failed:", err instanceof Error ? err.message : err);
    return new Response("Failed to persist webhook.", { status: 500 });
  }

  let tenant: CatcherTenant | null | undefined;
  try {
    tenant = await resolveCatcherTenant(admin, params.To ?? params.Called ?? null);
  } catch (err) {
    // Couldn't check — still greet generically and take the voicemail.
    console.error("[twilio-voice] tenant lookup failed:", err instanceof Error ? err.message : err);
    tenant = undefined;
  }
  if (tenant === null) {
    console.warn(`[twilio-voice] call to unknown catcher number ${params.To ?? "?"} (stored; no tenant).`);
    return twimlResponse(emptyTwiml());
  }

  const base = callbackBaseUrl(request);
  const recordingUrl = `${base}${VOICE_RECORDING_PATH}`;
  return twimlResponse(
    buildCatcherGreetingTwiml({
      companyName: tenant?.companyName ?? null,
      actionUrl: `${recordingUrl}?event=action`,
      recordingStatusUrl: `${recordingUrl}?event=status`,
      transcribeUrl: transcriptionEnabled() ? `${recordingUrl}?event=transcription` : null,
      maxLengthSeconds: voicemailMaxSeconds(voicemailMaxSecondsSetting()),
      voice: sayVoice(),
    }),
  );
}
