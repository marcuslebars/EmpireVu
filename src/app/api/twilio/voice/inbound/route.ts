import { enqueueInboundWebhookJob } from "@/server/services/inbound-webhook-jobs";
import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import {
  createMissedCallAdminClient,
  resolveCatcherTenant,
  VOICE_JOB_PROVIDER,
  type CatcherTenant,
} from "@/server/services/twilio/missed-call";
import { FORWARDING_TEST_LEG_KEY, findForwardingTestForLeg, isTestCallerId } from "@/server/services/twilio/forwarding-test";
import { verifyTwilioSignature } from "@/server/services/twilio/signature";
import {
  callbackBaseUrl,
  sayVoice,
  transcriptionEnabled,
  twilioSignedUrl,
  VOICE_AI_HANDOFF_PATH,
  VOICE_RECORDING_PATH,
  voicemailMaxSecondsSetting,
} from "@/server/services/twilio/voice-config";
import { startAiAnswer } from "@/server/services/voice/ai-answer";
import {
  buildAiHandoffTwiml,
  buildCatcherGreetingTwiml,
  buildForwardingTestLegTwiml,
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
 *   2) forwarding-test decision (docs/missed-call-catcher.md → Forwarding verification) —
 *      ONLY when From is one of OUR test caller IDs (the catcher number itself or the
 *      platform verifier; a pure check, so a customer call does no I/O before step 3): look
 *      up a test with caller_id == From and catcher_number == To that started within
 *      TEST_DETECT_WINDOW_MS. A match stamps its id into the job payload
 *      (FORWARDING_TEST_LEG_KEY) — the worker trusts that flag and never re-matches. A lookup
 *      error just leaves the flag off (the job is still persisted). The business line /
 *      ForwardedFrom are NOT fingerprints: real forwarded customers carry them;
 *   3) DURABLE-FIRST: enqueue the params into inbound_webhook_jobs
 *      (provider='twilio_voice', external_id=CallSid) — a redelivery is a no-op; a persist
 *      failure returns 500 (Twilio then plays its error / uses the number's fallback URL);
 *   4) a call from our own test caller ID → a bare <Hangup/> (it is never a customer: no
 *      greeting, no voicemail); the worker marks a flagged test passed;
 *   5) resolve the tenant by the CALLED number (voice_numbers, provider='twilio',
 *      mode='missed_call_catcher') only to say the company's name: unknown number → empty
 *      <Response/> (the job stays stored for ops); a lookup error → generic greeting;
 *   6) AI answering (docs/front-desk-ai.md → "## Phone answering"): when the company's
 *      call_answering mode is 'ai' and it has minutes left, claim the call (missed_calls row
 *      'ai_pending' — the worker then sends NO generic text-back), register it with Retell
 *      (tenant + HMAC token in the call metadata, never anything the caller says) and answer
 *      <Dial><Sip> to the AI. The <Dial> action (/api/twilio/voice/ai-handoff) falls back to
 *      the greeting + voicemail if the AI leg doesn't connect. Any failure before that →
 *      straight to step 7;
 *   7) otherwise answer with TwiML: greeting + <Record> voicemail (recording/transcription
 *      callbacks go to /api/twilio/voice/recording).
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
  // Our own key is set only by this route, never taken from the request.
  delete params[FORWARDING_TEST_LEG_KEY];
  const from = params.From ?? null;
  const to = params.To ?? params.Called ?? null;
  const fromOurTestCallerId = to !== null && isTestCallerId(from, to);
  let forwardingTestId: string | null = null;
  if (fromOurTestCallerId) {
    try {
      forwardingTestId = (await findForwardingTestForLeg(admin, { from, to }))?.id ?? null;
    } catch (err) {
      console.error("[twilio-voice] forwarding-test lookup failed (leg not flagged):", err instanceof Error ? err.message : err);
    }
  }
  const payload = forwardingTestId ? { ...params, [FORWARDING_TEST_LEG_KEY]: forwardingTestId } : params;

  try {
    await enqueueInboundWebhookJob(admin, { provider: VOICE_JOB_PROVIDER, externalId: callSid, payload });
  } catch (err) {
    console.error("[twilio-voice] durable enqueue failed:", err instanceof Error ? err.message : err);
    return new Response("Failed to persist webhook.", { status: 500 });
  }

  // Our own test caller ID is never a customer — no greeting, no voicemail.
  if (fromOurTestCallerId) return twimlResponse(buildForwardingTestLegTwiml());

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
  if (tenant) {
    const answer = await startAiAnswer(admin, { tenant, params });
    if (answer.kind === "ai") {
      return twimlResponse(
        buildAiHandoffTwiml({
          sipUri: answer.sipUri,
          actionUrl: `${base}${VOICE_AI_HANDOFF_PATH}?event=dial`,
          ringTimeoutSeconds: answer.ringTimeoutSeconds,
          timeLimitSeconds: answer.timeLimitSeconds,
        }),
      );
    }
  }

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
