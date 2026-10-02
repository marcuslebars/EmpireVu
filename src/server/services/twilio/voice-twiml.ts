/**
 * TwiML for the missed-call catcher (docs/missed-call-catcher.md). Pure + golden-tested.
 *
 * A call only reaches a catcher number because the business didn't pick up (carrier
 * conditional forwarding), so we answer with a short greeting in the company's name, tell
 * the caller a text is on its way, and record a voicemail. The text-back itself is sent by
 * the missed-call-text-back workflow off the `call.missed` event — not from here.
 */

export const DEFAULT_VOICEMAIL_MAX_SECONDS = 120;
export const DEFAULT_SAY_VOICE = "Polly.Joanna";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** Empty `<Response/>` — Twilio hangs up (voice) / sends nothing (SMS). */
export function emptyTwiml(): string {
  return `${XML_HEADER}<Response></Response>`;
}

export interface CatcherGreetingInput {
  /** Company name; null → a generic greeting (tenant lookup failed transiently). */
  companyName: string | null;
  /** Absolute URL Twilio requests when the recording ends (returns the goodbye TwiML). */
  actionUrl: string;
  /** Absolute URL for the async recording-status callback (durable voicemail capture). */
  recordingStatusUrl: string;
  /** Absolute URL for the transcription callback; null → no transcription. */
  transcribeUrl: string | null;
  maxLengthSeconds?: number;
  voice?: string;
}

/** The spoken greeting. Kept short — the caller already waited through the rings. */
export function catcherGreetingText(companyName: string | null): string {
  const name = companyName?.trim();
  return name
    ? `Sorry we missed your call. This is ${name}. We'll text you right away. Leave a message after the tone.`
    : "Sorry we missed your call. We'll text you right away. Leave a message after the tone.";
}

/** Clamp the voicemail cap to Twilio's sane range (5 s … 10 min). */
export function voicemailMaxSeconds(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VOICEMAIL_MAX_SECONDS;
  return Math.min(600, Math.max(5, Math.round(n)));
}

export function buildCatcherGreetingTwiml(input: CatcherGreetingInput): string {
  const voice = escapeXml(input.voice?.trim() || DEFAULT_SAY_VOICE);
  const maxLength = voicemailMaxSeconds(input.maxLengthSeconds ?? DEFAULT_VOICEMAIL_MAX_SECONDS);
  const recordAttrs = [
    `action="${escapeXml(input.actionUrl)}"`,
    `method="POST"`,
    `maxLength="${maxLength}"`,
    `timeout="5"`,
    `playBeep="true"`,
    `trim="trim-silence"`,
    `recordingStatusCallback="${escapeXml(input.recordingStatusUrl)}"`,
    `recordingStatusCallbackMethod="POST"`,
    `recordingStatusCallbackEvent="completed"`,
  ];
  if (input.transcribeUrl) {
    recordAttrs.push(`transcribe="true"`, `transcribeCallback="${escapeXml(input.transcribeUrl)}"`);
  }
  return (
    XML_HEADER +
    "<Response>" +
    `<Say voice="${voice}">${escapeXml(catcherGreetingText(input.companyName))}</Say>` +
    `<Record ${recordAttrs.join(" ")}/>` +
    "</Response>"
  );
}

/** After the voicemail (the <Record> action): thank them and hang up. */
export function buildVoicemailDoneTwiml(voice?: string): string {
  const v = escapeXml(voice?.trim() || DEFAULT_SAY_VOICE);
  return `${XML_HEADER}<Response><Say voice="${v}">Thanks, we got your message. Talk soon.</Say><Hangup/></Response>`;
}

export function twimlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { "Content-Type": "text/xml" } });
}
