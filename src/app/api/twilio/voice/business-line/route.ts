import { enforceWebhookBackstop } from "@/server/services/rate-limit";
import { businessLineResponse, readStage } from "@/server/services/staff/porting/business-line";
import { createMissedCallAdminClient } from "@/server/services/twilio/missed-call";
import { verifyTwilioVoiceSignature } from "@/server/services/twilio/voice-signature";
import { callbackBaseUrl, sayVoice } from "@/server/services/twilio/voice-config";
import { twimlResponse } from "@/server/services/twilio/voice-twiml";

export const dynamic = "force-dynamic";

/**
 * A ported business line's Voice URL (docs/ai-staff.md → "Keep your number"): ring the owner's
 * cell first, then the existing catcher path. Stages (our own signed query string):
 *
 *   (none)            a new call → <Dial> the owner (+ crew) for ring.seconds, screened;
 *   ?stage=screen     the owner's leg answered → "Call for <business>. Press 1 to take it.";
 *   ?stage=screened   their key press → bridge (1) or drop that leg;
 *   ?stage=after      the <Dial> ended → answered: hang up; otherwise <Redirect> to
 *                     /api/twilio/voice/inbound (AI answering / voicemail + text-back, unchanged).
 *
 * X-Twilio-Signature is verified first (fail closed → 403). The tenant comes only from the
 * called number (staff/porting/business-line.ts).
 */
export async function POST(request: Request): Promise<Response> {
  const backstop = await enforceWebhookBackstop(request, "twilio_voice_business_line");
  if (backstop) return backstop;

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  if (!verifyTwilioVoiceSignature(request, params, request.headers.get("x-twilio-signature"), process.env.TWILIO_AUTH_TOKEN)) {
    return new Response("Invalid signature.", { status: 403 });
  }

  const url = new URL(request.url);
  const xml = await businessLineResponse(createMissedCallAdminClient(), {
    stage: readStage(url),
    params,
    base: callbackBaseUrl(request),
    parent: url.searchParams.get("parent"),
    voice: sayVoice(),
  });
  return twimlResponse(xml);
}
