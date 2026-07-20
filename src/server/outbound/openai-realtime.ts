/**
 * OpenAI Realtime API — inbound SIP calls.
 *
 * NOTE ON SCOPE: unlike Cartesia (which owns the number and dials out), the
 * Realtime API is INBOUND-only over SIP — a trunk provider (Twilio/Telnyx) owns
 * the number and points at OpenAI, which then fires a `realtime.call.incoming`
 * webhook that we accept. This exists so the OpenAI voice can be compared
 * head-to-head with Marina; it is not an outbound replacement.
 *
 * Plain fetch, zero new dependencies — same as the Resend/Twilio/Cartesia clients.
 */

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_MODEL = "gpt-realtime-2.1";
const DEFAULT_VOICE = "alloy";

/**
 * Marina-equivalent persona so the comparison is fair. Override with
 * OPENAI_REALTIME_INSTRUCTIONS to paste the exact prompt used in Cartesia.
 */
const DEFAULT_INSTRUCTIONS = [
  "You are Marina, the voice assistant for A1 Marine Care, a boat detailing and marine services company.",
  "You are on a live phone call, so keep replies short, warm and natural — one or two sentences, no lists.",
  "Find out what boat the caller has and what service they need, answer their questions, and offer to book them in.",
  "If you don't know something, say the team will follow up rather than guessing.",
].join(" ");

export interface RealtimeConfig {
  apiKey: string;
  instructions: string;
  model: string;
  voice: string;
  webhookSecret: string;
}

/** Both the key and the webhook secret are required; null when not configured. */
export function readRealtimeConfig(): RealtimeConfig | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const webhookSecret = process.env.OPENAI_WEBHOOK_SECRET?.trim();
  if (!apiKey || !webhookSecret) {
    return null;
  }

  return {
    apiKey,
    instructions: process.env.OPENAI_REALTIME_INSTRUCTIONS?.trim() || DEFAULT_INSTRUCTIONS,
    model: process.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_MODEL,
    voice: process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_VOICE,
    webhookSecret,
  };
}

/**
 * Accept an incoming SIP call and configure the session that will handle it.
 * Must happen promptly — the caller is listening to ringing until it lands.
 */
export async function acceptRealtimeCall(
  callId: string,
  config: RealtimeConfig,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${OPENAI_REALTIME_CALLS_URL}/${encodeURIComponent(callId)}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instructions: config.instructions,
          model: config.model,
          type: "realtime",
          voice: config.voice,
        }),
      },
    );
  } catch (error) {
    throw new Error(
      `OpenAI accept request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
}
