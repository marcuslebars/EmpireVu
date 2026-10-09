import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import { createMissedCallAdminClient, resolveCatcherTenant } from "@/server/services/twilio/missed-call";
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
  buildHangupTwiml,
  twimlResponse,
  voicemailMaxSeconds,
} from "@/server/services/twilio/voice-twiml";
import { releaseForFallback, storedCallParams } from "@/server/services/voice/ai-answer";

export const dynamic = "force-dynamic";

/**
 * The <Dial> action of an AI-answered catcher call (docs/front-desk-ai.md → "## Phone
 * answering"). Twilio requests it when the SIP leg to Retell ends:
 *
 *   DialCallStatus=completed  the AI talked to the caller → <Hangup/>. The post-call Retell
 *                             webhook does the rest (summary, owner alert, ONE follow-up text).
 *   anything else             (no-answer / busy / failed / canceled) the AI never picked up →
 *                             release the call back to the normal missed-call path (lead +
 *                             generic text-back, via a durable release job) and answer with the
 *                             usual greeting + <Record> voicemail, so the caller is never lost.
 *
 * Signature-verified (the signed URL includes ?event=dial). Tenant only from the called
 * catcher number, for the greeting's company name.
 */
export async function POST(request: Request): Promise<Response> {
  const backstop = await enforceWebhookBackstop(request, "twilio_voice_ai_handoff");
  if (backstop) return backstop;

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  if (!verifyTwilioSignature(twilioSignedUrl(request), params, request.headers.get("x-twilio-signature"), process.env.TWILIO_AUTH_TOKEN)) {
    return new Response("Invalid signature.", { status: 403 });
  }

  const status = (params.DialCallStatus ?? "").toLowerCase();
  if (status === "completed" || !params.CallSid) return twimlResponse(buildHangupTwiml());

  const admin = createMissedCallAdminClient();
  let original: Record<string, string> | null = null;
  try {
    original = await storedCallParams(admin, params.CallSid);
  } catch (err) {
    console.error("[voice-ai] could not read the stored call (releasing with the action params):", err instanceof Error ? err.message : err);
  }
  await releaseForFallback(admin, params.CallSid, original ?? params);
  console.warn(`[voice-ai] AI leg for ${params.CallSid} ended '${status || "unknown"}' (SIP ${params.DialSipResponseCode ?? "?"}) — voicemail fallback.`);

  let companyName: string | null = null;
  try {
    companyName = (await resolveCatcherTenant(admin, params.To ?? params.Called ?? null))?.companyName ?? null;
  } catch {
    companyName = null;
  }
  const recordingUrl = `${callbackBaseUrl(request)}${VOICE_RECORDING_PATH}`;
  return twimlResponse(
    buildCatcherGreetingTwiml({
      companyName,
      actionUrl: `${recordingUrl}?event=action`,
      recordingStatusUrl: `${recordingUrl}?event=status`,
      transcribeUrl: transcriptionEnabled() ? `${recordingUrl}?event=transcription` : null,
      maxLengthSeconds: voicemailMaxSeconds(voicemailMaxSecondsSetting()),
      voice: sayVoice(),
    }),
  );
}
