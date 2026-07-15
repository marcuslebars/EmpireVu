/**
 * Customer-facing SMS send via the Twilio REST API.
 *
 * Same contract as outbound/email.ts: an explicit human click sends this to a real
 * customer, so failures throw rather than degrade, and there is no automatic retry
 * (an ambiguous timeout must not turn into two texts).
 *
 * Uses fetch + Basic auth rather than the twilio SDK — it keeps the dependency
 * footprint at zero and matches how Resend is already called in this repo.
 */

import { OutboundNotConfiguredError, OutboundSendError } from "@/server/outbound/email";

export interface SendSmsInput {
  to: string;
  body: string;
}

export interface OutboundSmsConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

export function readSmsConfig(): OutboundSmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    return null;
  }

  return { accountSid, authToken, from };
}

export function isSmsSendConfigured(): boolean {
  return readSmsConfig() !== null;
}

export async function sendSms(input: SendSmsInput): Promise<void> {
  const config = readSmsConfig();

  if (!config) {
    throw new OutboundNotConfiguredError(
      "SMS sending is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER on the server.",
    );
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    config.accountSid,
  )}/Messages.json`;

  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        Body: input.body,
        From: config.from,
        To: input.to,
      }).toString(),
    });
  } catch (error) {
    throw new OutboundSendError(
      `Could not reach Twilio: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    // Twilio returns a JSON body with a human-readable `message` on failure.
    const detail = await response
      .json()
      .then((payload: unknown) =>
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : "",
      )
      .catch(() => "");

    throw new OutboundSendError(
      `Twilio rejected the message (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
}
