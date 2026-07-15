/**
 * Customer-facing email send via the Resend REST API.
 *
 * Deliberately different from lead-intake/notify.ts, which emails the OWNER and is
 * best-effort (a failed notification must never fail an intake). This one emails a
 * real CUSTOMER on an explicit human click, so it throws on failure: the reviewer
 * needs to know it didn't go out.
 *
 * No retry, on purpose. A network timeout is ambiguous — the message may well have
 * been accepted — and silently retrying risks sending a customer the same email
 * twice. Draft-first keeps a human in the loop, so a failure surfaces and they can
 * press send again themselves.
 *
 * Uses fetch rather than the resend SDK to match the existing house pattern (notify.ts)
 * and to avoid adding a dependency.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface OutboundEmailConfig {
  apiKey: string;
  from: string;
  replyTo: string | null;
}

export class OutboundNotConfiguredError extends Error {}

export class OutboundSendError extends Error {}

export function readEmailConfig(): OutboundEmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.OUTBOUND_FROM_EMAIL ?? process.env.LEAD_FROM_EMAIL;

  if (!apiKey || !from) {
    return null;
  }

  return { apiKey, from, replyTo: process.env.OUTBOUND_REPLY_TO ?? null };
}

export function isEmailSendConfigured(): boolean {
  return readEmailConfig() !== null;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const config = readEmailConfig();

  if (!config) {
    throw new OutboundNotConfiguredError(
      "Email sending is not configured. Set RESEND_API_KEY and OUTBOUND_FROM_EMAIL on the server.",
    );
  }

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [input.to],
        subject: input.subject,
        text: input.body,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
    });
  } catch (error) {
    throw new OutboundSendError(
      `Could not reach Resend: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OutboundSendError(
      `Resend rejected the email (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
}
