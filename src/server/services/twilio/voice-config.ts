/**
 * Env-backed settings for the missed-call catcher (docs/missed-call-catcher.md). All
 * optional, with documented defaults; read at call time so tests can stub process.env.
 *
 *   TWILIO_WEBHOOK_BASE_URL            [web]    public origin Twilio calls (default APP_BASE_URL)
 *   MISSED_CALL_TEXTBACK_WINDOW_MINUTES [worker] repeat-caller text-back suppression (default 10)
 *   MISSED_CALL_VOICEMAIL_MAX_SECONDS   [web]    voicemail cap (default 120)
 *   MISSED_CALL_TRANSCRIBE              [web]    "true" → Twilio voicemail transcription (default off)
 *   TWILIO_SAY_VOICE                    [web]    <Say> voice (default Polly.Joanna)
 *   TWILIO_NUMBER_COUNTRY               [web]    country to buy catcher numbers in (default CA)
 *   TWILIO_FORWARDING_TEST_FROM         [web, worker] optional platform verifier number used as the
 *                                       caller ID of forwarding test calls (default: the catcher number)
 */

export const DEFAULT_TEXTBACK_WINDOW_MINUTES = 10;

function trimmed(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** Public origin Twilio reaches us on (no trailing slash), or null when unconfigured. */
export function twilioWebhookBaseUrl(): string | null {
  const base = trimmed("TWILIO_WEBHOOK_BASE_URL") ?? trimmed("APP_BASE_URL");
  return base ? base.replace(/\/+$/, "") : null;
}

/** Base URL for callback URLs we hand Twilio in TwiML; falls back to the request origin. */
export function callbackBaseUrl(request: Request): string {
  return twilioWebhookBaseUrl() ?? new URL(request.url).origin;
}

/**
 * The exact URL Twilio signed. Twilio signs the URL it requested (configured on the number,
 * or the callback URL we put in TwiML — always built from the same base). Behind a proxy
 * that is not request.url, so rebuild it from the configured base + path + query.
 */
export function twilioSignedUrl(request: Request): string {
  const url = new URL(request.url);
  const base = twilioWebhookBaseUrl();
  return base ? `${base}${url.pathname}${url.search}` : request.url;
}

export function textBackWindowMinutes(): number {
  const raw = Number.parseInt(trimmed("MISSED_CALL_TEXTBACK_WINDOW_MINUTES") ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TEXTBACK_WINDOW_MINUTES;
}

export function voicemailMaxSecondsSetting(): string | null {
  return trimmed("MISSED_CALL_VOICEMAIL_MAX_SECONDS");
}

export function transcriptionEnabled(): boolean {
  return (trimmed("MISSED_CALL_TRANSCRIBE") ?? "").toLowerCase() === "true";
}

export function sayVoice(): string | undefined {
  return trimmed("TWILIO_SAY_VOICE") ?? undefined;
}

export function numberCountry(): string {
  return (trimmed("TWILIO_NUMBER_COUNTRY") ?? "CA").toUpperCase();
}

/**
 * Caller ID for a forwarding test call (docs/missed-call-catcher.md → Forwarding
 * verification). A dedicated platform verifier number (TWILIO_FORWARDING_TEST_FROM — a
 * Twilio number in the same account, NOT a catcher number) when set, else the company's own
 * catcher number. Returns E.164.
 */
export function forwardingTestCallerId(catcherNumberE164: string): string {
  const raw = trimmed("TWILIO_FORWARDING_TEST_FROM");
  if (!raw) return catcherNumberE164;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? `+${digits}` : catcherNumberE164;
}

/** The configured verifier number (E.164) or null — used to recognise test legs. */
export function forwardingTestVerifierNumber(): string | null {
  const raw = trimmed("TWILIO_FORWARDING_TEST_FROM");
  if (!raw) return null;
  const value = forwardingTestCallerId("");
  return value || null;
}

export const VOICE_INBOUND_PATH = "/api/twilio/voice/inbound";
export const VOICE_RECORDING_PATH = "/api/twilio/voice/recording";
export const SMS_INBOUND_PATH = "/api/twilio/sms/inbound";
export const FORWARDING_TEST_CALLBACK_PATH = "/api/twilio/voice/forwarding-test";
/** <Dial> action for an AI-answered call (docs/front-desk-ai.md → "## Phone answering"). */
export const VOICE_AI_HANDOFF_PATH = "/api/twilio/voice/ai-handoff";
