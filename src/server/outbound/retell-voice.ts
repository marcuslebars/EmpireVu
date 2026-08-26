/**
 * Outbound voice calls via Retell (create-phone-call) — the Retell replacement for the
 * Cartesia "Marina" outbound agent. Same contract discipline as outbound/voice.ts: this
 * places a REAL call to a real person, so failures throw rather than degrade, and there
 * is NO automatic retry — an ambiguous timeout must never become two calls.
 *
 * The outcome is NOT polled here (unlike Cartesia's fetchCallDetails): Retell POSTs a
 * `call_analyzed` webhook when the call ends, and the receiver attaches the outcome to
 * the contact by the `metadata` we send below. See docs/retell-integration.md.
 *
 * fetch + Bearer — zero new dependencies.
 */
import { OutboundNotConfiguredError, OutboundSendError } from "@/server/outbound/email";

const RETELL_CREATE_CALL_URL = "https://api.retellai.com/v2/create-phone-call";

export interface RetellVoiceConfig {
  apiKey: string;
  fromNumber: string;
  /** Dedicated outbound agent; when null, Retell uses the from-number's default agent. */
  agentId: string | null;
}

/** apiKey + fromNumber are required; returns null when outbound voice isn't fully configured. */
export function readRetellVoiceConfig(): RetellVoiceConfig | null {
  const apiKey = process.env.RETELL_API_KEY?.trim();
  const fromNumber = process.env.RETELL_FROM_NUMBER?.trim();
  const agentId = process.env.RETELL_OUTBOUND_AGENT_ID?.trim() || null;
  if (!apiKey || !fromNumber) return null;
  return { apiKey, fromNumber, agentId };
}

export interface PlaceRetellCallInput {
  /** Destination in E.164, e.g. +14155559876. */
  toNumber: string;
  /** Arbitrary object echoed back on the call object — the webhook reads it to attach the outcome. */
  metadata?: Record<string, unknown>;
  /** String-valued variables the agent's prompt interpolates, e.g. {{customer_name}}, {{company_name}}. */
  dynamicVariables?: Record<string, string>;
}

export interface PlaceRetellCallResult {
  callId: string | null;
  toNumber: string;
}

/** Build the create-phone-call request body (pure — unit tested). */
export function buildCreateCallBody(
  config: RetellVoiceConfig,
  input: PlaceRetellCallInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from_number: config.fromNumber,
    to_number: input.toNumber,
  };
  if (config.agentId) body.override_agent_id = config.agentId;
  if (input.metadata && Object.keys(input.metadata).length > 0) body.metadata = input.metadata;
  if (input.dynamicVariables && Object.keys(input.dynamicVariables).length > 0) {
    body.retell_llm_dynamic_variables = input.dynamicVariables;
  }
  return body;
}

export async function placeRetellCall(
  input: PlaceRetellCallInput,
  config: RetellVoiceConfig | null = readRetellVoiceConfig(),
): Promise<PlaceRetellCallResult> {
  if (!config) {
    throw new OutboundNotConfiguredError(
      "Retell outbound calling is not configured. Set RETELL_API_KEY and RETELL_FROM_NUMBER.",
    );
  }

  let response: Response;
  try {
    response = await fetch(RETELL_CREATE_CALL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildCreateCallBody(config, input)),
    });
  } catch (error) {
    throw new OutboundSendError(
      `Retell call request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OutboundSendError(
      `Retell returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }

  const json = (await response.json().catch(() => null)) as { call_id?: string } | null;
  return { callId: json?.call_id ?? null, toNumber: input.toNumber };
}
