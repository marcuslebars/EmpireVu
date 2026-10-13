/**
 * X-Twilio-Signature checks for the VOICE webhooks (inbound, recording, ai-handoff,
 * business-line, forwarding-test).
 *
 * Twilio signs the exact URL it requested: the Voice URL configured on the number, or a callback
 * URL we put in TwiML. Behind our proxy that is not request.url, so we rebuild it. Until the
 * Everdoer rebrand this checked ONE base (TWILIO_WEBHOOK_BASE_URL ?? APP_BASE_URL); changing that
 * env would have 403'd every call on a number still configured with the old host
 * (REBRAND_PLAN.md §2). Like inbound SMS (sms-signed-urls.ts), voice now tries a short candidate
 * list, each with the SAME path and query:
 *   1. the configured base (TWILIO_WEBHOOK_BASE_URL, else APP_BASE_URL);
 *   2. the host the request arrived on (x-forwarded-host / host, https);
 *   3. the platform's own hosts, old and new (rebrand/platform-hosts.ts);
 *   4. request.url itself, only when no base is configured (the previous behaviour).
 * Nothing else. Every candidate still needs a valid HMAC-SHA1 under TWILIO_AUTH_TOKEN over the
 * URL + the sorted POST params (verifyTwilioSignature, unchanged), so the list never accepts an
 * unsigned or forged request; it only stops a host change from rejecting genuine ones.
 *
 * A match on an OLD platform host is counted (legacy_usage kind twilio_signature, key = the
 * host, sample = the path): that is the list of numbers still to re-point (job:twilio-repoint).
 */
import { noteLegacyUsage, sampleFromUrl } from "@/server/services/rebrand/legacy-usage";
import { isOldPlatformHost, PLATFORM_HOSTS } from "@/server/services/rebrand/platform-hosts";
import { verifyTwilioSignature } from "@/server/services/twilio/signature";
import { twilioWebhookBaseUrl } from "@/server/services/twilio/voice-config";

/** The URLs Twilio may have signed for this voice request, most likely first. */
export function twilioVoiceUrlCandidates(request: Request): string[] {
  const url = new URL(request.url);
  const suffix = `${url.pathname}${url.search}`;
  const out: string[] = [];
  const add = (u: string | null | undefined) => {
    const v = u?.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const base = twilioWebhookBaseUrl();
  if (base) add(`${base}${suffix}`);
  const arriving = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))?.split(",")[0]?.trim();
  if (arriving) add(`https://${arriving}${suffix}`);
  // Rebrand shim (remove in PR 8 once legacy_usage shows no twilio_signature/<old host> for 30 days)
  for (const host of PLATFORM_HOSTS) add(`https://${host}${suffix}`);
  if (!base) add(request.url);
  return out;
}

/**
 * Verify a Twilio voice webhook against every candidate URL. `params` are the form POST params,
 * exactly as before. Fails closed (no token / no header / no match → false).
 */
export function verifyTwilioVoiceSignature(
  request: Request,
  params: Record<string, string>,
  signatureHeader: string | null | undefined,
  authToken: string | null | undefined,
): boolean {
  if (!authToken || !signatureHeader) return false;
  for (const candidate of twilioVoiceUrlCandidates(request)) {
    if (!verifyTwilioSignature(candidate, params, signatureHeader, authToken)) continue;
    let host: string | null = null;
    try {
      host = new URL(candidate).host;
    } catch {
      host = null;
    }
    if (host && isOldPlatformHost(host)) {
      noteLegacyUsage("twilio_signature", host.toLowerCase(), sampleFromUrl(candidate));
    }
    return true;
  }
  return false;
}
