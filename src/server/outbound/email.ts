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
import { UserFacingError } from "@/server/errors";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  /** Optional HTML alternative. `body` remains the plain-text part. */
  html?: string;
  /**
   * Display name on the From line, e.g. "A1 Marine Storage". The ADDRESS stays
   * the configured, domain-verified sender — an arbitrary per-brand address would
   * fail SPF/DKIM — but the display name is what a recipient reads first, so this
   * is what makes the mail read as the brand rather than the platform.
   */
  fromName?: string;
  /** Per-message reply-to, so a customer replying reaches the brand. */
  replyTo?: string;
  /** Files to attach (e.g. the invoice PDF). `content` is base64. */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  /** Base64-encoded file bytes. */
  content: string;
}

export interface OutboundEmailConfig {
  apiKey: string;
  from: string;
  replyTo: string | null;
}

/**
 * Sending (email / SMS / calls) isn't set up on this server. The message is shown to
 * the owner as-is, so it says what happened in plain words; which env var is missing
 * goes in `detail`, for the logs only. → 503
 */
export class OutboundNotConfiguredError extends UserFacingError {
  constructor(
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message, { status: 503, code: "outbound_not_configured" });
    this.name = "OutboundNotConfiguredError";
    if (detail) console.error(`[outbound] ${message} (${detail})`);
  }
}

/**
 * The provider refused or couldn't be reached. Plain message for the owner; the
 * provider's own status and body (JSON, ids) stay in `detail` for the logs. → 502
 */
export class OutboundSendError extends UserFacingError {
  constructor(
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message, { status: 502, code: "outbound_send_failed" });
    this.name = "OutboundSendError";
    if (detail) console.error(`[outbound] ${message} (${detail.slice(0, 500)})`);
  }
}

export function readEmailConfig(): OutboundEmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  // `||` not `??`: a variable that exists but is blank (easy to do in a hosting
  // dashboard) should fall back, not silently defeat the fallback.
  const from = process.env.OUTBOUND_FROM_EMAIL || process.env.LEAD_FROM_EMAIL;

  if (!apiKey || !from) {
    return null;
  }

  return { apiKey, from, replyTo: process.env.OUTBOUND_REPLY_TO || null };
}

export function isEmailSendConfigured(): boolean {
  return readEmailConfig() !== null;
}

/** The Resend message id, when returned — used as the usage idempotency key. */
export interface SendEmailResult {
  id: string | null;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const config = readEmailConfig();

  if (!config) {
    throw new OutboundNotConfiguredError(
      "Email sending isn't set up yet, so nothing was sent. Please contact support.",
      "RESEND_API_KEY / OUTBOUND_FROM_EMAIL missing",
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
        from: formatFrom(config.from, input.fromName),
        to: [input.to],
        subject: input.subject,
        text: input.body,
        ...(input.html ? { html: input.html } : {}),
        ...(input.replyTo || config.replyTo
          ? { reply_to: input.replyTo || config.replyTo }
          : {}),
        ...(input.attachments?.length
          ? { attachments: input.attachments.map((a) => ({ filename: a.filename, content: a.content })) }
          : {}),
      }),
    });
  } catch (error) {
    throw new OutboundSendError(
      "The email couldn't be sent because the email service didn't respond. Please try again in a few minutes.",
      `Resend unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OutboundSendError(
      response.status === 422 || response.status === 400
        ? "The email service refused this email — check the email address and try again."
        : "The email couldn't be sent. Please try again in a few minutes.",
      `Resend rejected the email (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  let id: string | null = null;
  try {
    const payload = (await response.json()) as unknown;
    if (payload && typeof payload === "object" && "id" in payload) {
      id = String((payload as { id: unknown }).id);
    }
  } catch {
    // No/invalid JSON body — we simply won't have a provider id for metering.
  }
  return { id };
}

/**
 * Build an RFC 5322 From value: `"Display Name" <address>`.
 *
 * Quotes and backslashes are stripped from the name — an unescaped quote in a
 * brand name would break the header and get the whole message rejected, so a
 * stray character in a company record must not be able to stop mail going out.
 */
export function formatFrom(address: string, displayName?: string): string {
  const name = displayName?.trim();
  if (!name) return address;
  // If the configured sender is already `Name <addr>`, keep only the address.
  const bare = address.match(/<([^>]+)>/)?.[1] ?? address;
  const safe = name.replace(/["\\]/g, "").trim();
  if (!safe) return bare;
  return `"${safe}" <${bare}>`;
}
