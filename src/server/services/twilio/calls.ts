/**
 * Minimal Twilio Calls REST client for the forwarding test (docs/missed-call-catcher.md →
 * "Forwarding verification"). Same style as the numbers client in provision.ts: fetch,
 * Basic auth, form-encoded. Behind an interface so tests never touch the real API.
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export interface CreateTestCallInput {
  /** The business line (E.164). */
  to: string;
  /** Caller ID (E.164) — a Twilio number in this account (catcher or verifier). */
  from: string;
  /** Inline TwiML Twilio runs if the call is answered (owner / voicemail picked up). */
  twiml: string;
  /** How long Twilio lets it ring before giving up (seconds). */
  timeoutSeconds: number;
  /** Final call-status callback (completed / busy / no-answer / failed / canceled). */
  statusCallbackUrl: string;
  /** Async answering-machine-detection callback (AnsweredBy: human | machine_* | fax | unknown). */
  amdCallbackUrl: string;
}

export interface CreatedCall {
  sid: string;
  status: string | null;
}

export interface TwilioCallsClient {
  createCall(input: CreateTestCallInput): Promise<CreatedCall>;
}

/** A Twilio REST error with Twilio's numeric error code when it sent one (e.g. 21211). */
export class TwilioApiError extends Error {
  readonly code: string | null;
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number, code: string | null) {
    super(message);
    this.name = "TwilioApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function createTwilioCallsClient(creds: { accountSid: string; authToken: string }): TwilioCallsClient {
  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`;
  const url = `${TWILIO_API}/Accounts/${encodeURIComponent(creds.accountSid)}/Calls.json`;

  return {
    async createCall(input) {
      const form = new URLSearchParams({
        To: input.to,
        From: input.from,
        Twiml: input.twiml,
        Timeout: String(input.timeoutSeconds),
        StatusCallback: input.statusCallbackUrl,
        StatusCallbackMethod: "POST",
        // Async AMD tells "answered by a person" from "answered by voicemail" — the most
        // common way forwarding fails is the carrier's voicemail picking up first.
        MachineDetection: "Enable",
        AsyncAmd: "true",
        AsyncAmdStatusCallback: input.amdCallbackUrl,
        AsyncAmdStatusCallbackMethod: "POST",
      });
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const payload: unknown = await response.json().catch(() => null);
      const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      if (!response.ok) {
        const code = record.code === undefined || record.code === null ? null : String(record.code);
        const message = typeof record.message === "string" ? record.message : `Twilio call failed (${response.status})`;
        throw new TwilioApiError(message, response.status, code);
      }
      const sid = typeof record.sid === "string" ? record.sid : "";
      if (!sid) throw new TwilioApiError("Twilio returned no call sid.", response.status, null);
      return { sid, status: typeof record.status === "string" ? record.status : null };
    },
  };
}
