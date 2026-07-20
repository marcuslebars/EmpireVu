/**
 * Outbound voice calls via Cartesia's agents API (the "Line" voice-agent product).
 * A deployed agent (e.g. "Marina") phones a lead. Same contract discipline as
 * outbound/email.ts and outbound/sms.ts: this places a REAL call to a real person,
 * so failures throw rather than degrade, and there is no automatic retry — an
 * ambiguous timeout must never turn into two calls.
 *
 * fetch + X-API-Key, matching how Resend/Twilio are already called here — zero
 * new dependencies.
 */
import { OutboundNotConfiguredError, OutboundSendError } from "@/server/outbound/email";

const CARTESIA_CALLS_URL = "https://api.cartesia.ai/agents/calls";
const CARTESIA_VERSION = "2026-03-01";
const RINGING_TIMEOUT_SECONDS = 30;

export interface VoiceConfig {
  apiKey: string;
  agentId: string;
  fromNumberId: string;
}

/** All three are required; returns null if the voice agent isn't fully configured. */
export function readVoiceConfig(): VoiceConfig | null {
  const apiKey = process.env.CARTESIA_API_KEY?.trim();
  const agentId = process.env.CARTESIA_AGENT_ID?.trim();
  const fromNumberId = process.env.CARTESIA_FROM_NUMBER_ID?.trim();
  if (!apiKey || !agentId || !fromNumberId) {
    return null;
  }
  return { apiKey, agentId, fromNumberId };
}

export interface PlaceCallInput {
  /** Destination number in E.164 format, e.g. +14155559876. */
  toNumber: string;
  /** Passed through to the agent (accessible as call_request.metadata). */
  metadata?: Record<string, unknown>;
}

export interface PlaceCallResult {
  agentCallId: string | null;
  toNumber: string;
}

export async function placeOutboundCall(
  input: PlaceCallInput,
  config: VoiceConfig | null = readVoiceConfig(),
): Promise<PlaceCallResult> {
  if (!config) {
    throw new OutboundNotConfiguredError(
      "Voice calling is not configured. Set CARTESIA_API_KEY, CARTESIA_AGENT_ID, and CARTESIA_FROM_NUMBER_ID.",
    );
  }

  let response: Response;
  try {
    response = await fetch(CARTESIA_CALLS_URL, {
      method: "POST",
      headers: {
        "X-API-Key": config.apiKey,
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_number_id: config.fromNumberId,
        agent_id: config.agentId,
        ringing_timeout_seconds: RINGING_TIMEOUT_SECONDS,
        outbound_calls: [{ to_number: input.toNumber, metadata: input.metadata ?? {} }],
      }),
    });
  } catch (error) {
    throw new OutboundSendError(
      `Cartesia call request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OutboundSendError(
      `Cartesia returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }

  const json = (await response.json().catch(() => null)) as {
    calls?: Array<{ number?: string; agent_call_id?: string }>;
  } | null;
  const call = json?.calls?.[0];
  return { agentCallId: call?.agent_call_id ?? null, toNumber: input.toNumber };
}

export interface CallDetails {
  endReason: string | null;
  endTime: string | null;
  errorMessage: string | null;
  startTime: string | null;
  /** created | started | completed | failed */
  status: string | null;
  summary: string | null;
}

/**
 * Read a placed call's outcome. Only "completed" and "failed" are terminal —
 * anything else means the call is still ringing or in progress.
 */
export async function fetchCallDetails(
  agentCallId: string,
  config: VoiceConfig | null = readVoiceConfig(),
): Promise<CallDetails> {
  if (!config) {
    throw new OutboundNotConfiguredError("Voice calling is not configured.");
  }

  let response: Response;
  try {
    response = await fetch(`${CARTESIA_CALLS_URL}/${encodeURIComponent(agentCallId)}`, {
      headers: {
        // Cartesia's docs disagree: the outbound-dialing page documents
        // `X-API-Key` (what our working call uses) while the API-conventions
        // page documents `Authorization: Bearer`. Send both so either satisfies.
        Authorization: `Bearer ${config.apiKey}`,
        "Cartesia-Version": CARTESIA_VERSION,
        "X-API-Key": config.apiKey,
      },
    });
  } catch (error) {
    throw new OutboundSendError(
      `Cartesia call lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OutboundSendError(
      `Cartesia returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }

  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const readString = (key: string): string | null =>
    typeof json?.[key] === "string" ? (json[key] as string) : null;

  return {
    endReason: readString("end_reason"),
    endTime: readString("end_time"),
    errorMessage: readString("error_message"),
    startTime: readString("start_time"),
    status: readString("status"),
    summary: readString("summary"),
  };
}
