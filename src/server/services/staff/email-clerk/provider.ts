/**
 * Inbound email, behind a small seam (`InboundEmailProvider`) so tests and the e2e fakes can drive
 * it. The one implementation is Resend Inbound (checked against the live docs, Oct 2026):
 *
 *   webhook  POST, event `email.received`, Svix-signed (signing.ts). The payload is METADATA only:
 *            data.{email_id, created_at, from, to[], cc[], bcc[], received_for[], message_id,
 *            subject, attachments[{id, filename, content_type, content_disposition, content_id}]}.
 *   content  GET https://api.resend.com/emails/receiving/{email_id} → {from, to[], cc[], reply_to[],
 *            subject, text, html, headers{}, message_id, received_for[], authentication{spf,dkim,
 *            dmarc}, attachments[{id, filename, content_type, content_disposition, content_id, size}]}
 *   files    GET https://api.resend.com/emails/receiving/{email_id}/attachments/{id} → {download_url,
 *            expires_at (1 h), size, content_type, filename}; the bytes come from download_url.
 *
 * Uses RESEND_API_KEY (needs receiving access). Nothing here follows a link from an email: the only
 * URL fetched is the attachment `download_url` Resend's own API returned, and only on Resend's hosts.
 */
import { verifySvixSignature, type VerifyResult } from "./signing";

export interface InboundWebhookData {
  emailId: string;
  messageId: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  receivedFor: string[];
  subject: string | null;
  createdAt: string | null;
}

export type InboundWebhookEvent = { type: "email.received"; data: InboundWebhookData } | { type: "other"; eventType: string };

export interface FetchedAttachmentMeta {
  id: string;
  filename: string | null;
  contentType: string | null;
  disposition: string | null;
  contentId: string | null;
  size: number | null;
}

export interface FetchedEmail {
  id: string;
  from: string | null;
  to: string[];
  cc: string[];
  replyTo: string[];
  receivedFor: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  /** Lower-cased header names; a repeated header is joined with ", ". */
  headers: Record<string, string>;
  messageId: string | null;
  authentication: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  attachments: FetchedAttachmentMeta[];
  createdAt: string | null;
}

export interface FetchedAttachment {
  bytes: Uint8Array;
  contentType: string | null;
  filename: string | null;
}

export interface InboundEmailProvider {
  name: string;
  /** Verify a webhook delivery and read its event. `{ ok: false }` → reject (400). */
  verify(request: { rawBody: string; headers: { get(name: string): string | null } }, nowMs?: number): { ok: true; event: InboundWebhookEvent } | { ok: false; reason: string };
  /** The full email. null → not found; throws on a transient failure (retried later). */
  fetchEmail(id: string): Promise<FetchedEmail | null>;
  /** One attachment's bytes (≤ maxBytes). null → gone or too big. Throws on a transient failure. */
  fetchAttachment(emailId: string, attachmentId: string, maxBytes: number): Promise<FetchedAttachment | null>;
}

// ── Parsing what Resend sends (PURE) ────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.map(str).filter((v): v is string => Boolean(v)).slice(0, 50) : [];
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseWebhookEvent(body: unknown): InboundWebhookEvent | null {
  const b = rec(body);
  const type = str(b.type);
  if (!type) return null;
  if (type !== "email.received") return { type: "other", eventType: type };
  const d = rec(b.data);
  const emailId = str(d.email_id);
  if (!emailId) return null;
  return {
    type: "email.received",
    data: {
      emailId,
      messageId: str(d.message_id),
      from: str(d.from),
      to: strList(d.to),
      cc: strList(d.cc),
      bcc: strList(d.bcc),
      receivedFor: strList(d.received_for),
      subject: str(d.subject),
      createdAt: str(d.created_at),
    },
  };
}

function headerMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    // [{name, value}] shape, just in case.
    for (const item of value) {
      const name = str(rec(item).name);
      const v = str(rec(item).value);
      if (name && v) out[name.toLowerCase()] = out[name.toLowerCase()] ? `${out[name.toLowerCase()]}, ${v}` : v;
    }
    return out;
  }
  for (const [name, v] of Object.entries(rec(value))) {
    const text = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : typeof v === "string" ? v : null;
    if (text != null) out[name.toLowerCase()] = text.slice(0, 4000);
  }
  return out;
}

function authOf(value: unknown): FetchedEmail["authentication"] {
  const a = rec(value);
  if (Object.keys(a).length === 0) return null;
  const v = (k: string) => (typeof a[k] === "string" ? (a[k] as string).toLowerCase() : null);
  return { spf: v("spf"), dkim: v("dkim"), dmarc: v("dmarc") };
}

export function parseFetchedEmail(body: unknown): FetchedEmail | null {
  const b = rec(body);
  const id = str(b.id);
  if (!id) return null;
  return {
    id,
    from: str(b.from),
    to: strList(b.to),
    cc: strList(b.cc),
    replyTo: strList(b.reply_to),
    receivedFor: strList(b.received_for),
    subject: str(b.subject),
    text: typeof b.text === "string" ? b.text : null,
    html: typeof b.html === "string" ? b.html : null,
    headers: headerMap(b.headers),
    messageId: str(b.message_id),
    authentication: authOf(b.authentication),
    attachments: (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 30).flatMap((raw) => {
      const a = rec(raw);
      const attId = str(a.id);
      if (!attId) return [];
      return [{ id: attId, filename: str(a.filename), contentType: str(a.content_type), disposition: str(a.content_disposition), contentId: str(a.content_id), size: typeof a.size === "number" ? a.size : null }];
    }),
    createdAt: str(b.created_at),
  };
}

/** Only Resend's own hosts serve attachment bytes (SSRF guard on `download_url`). PURE. */
export function isResendDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === "resend.com" || host.endsWith(".resend.com") || host.endsWith(".resend.app");
  } catch {
    return false;
  }
}

// ── Resend ──────────────────────────────────────────────────────────────────────

const API = "https://api.resend.com";
const FETCH_TIMEOUT_MS = 8_000;

class TransientError extends Error {}

async function getJson(path: string): Promise<unknown | null> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) throw new TransientError("RESEND_API_KEY is not set");
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new TransientError(`Resend ${res.status}`);
  return res.json();
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export const resendInboundProvider: InboundEmailProvider = {
  name: "resend",
  verify(request, nowMs = Date.now()) {
    const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
    if (!secret) return { ok: false, reason: "not_configured" };
    const result: VerifyResult = verifySvixSignature(
      secret,
      { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") },
      request.rawBody,
      nowMs,
    );
    if ("reason" in result) return { ok: false, reason: result.reason };
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.rawBody);
    } catch {
      return { ok: false, reason: "bad_json" };
    }
    const event = parseWebhookEvent(parsed);
    return event ? { ok: true, event } : { ok: false, reason: "bad_event" };
  },
  async fetchEmail(id) {
    const body = await getJson(`/emails/receiving/${encodeURIComponent(id)}`);
    return body == null ? null : parseFetchedEmail(body);
  },
  async fetchAttachment(emailId, attachmentId, maxBytes) {
    const meta = rec(await getJson(`/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`));
    const url = str(meta.download_url);
    if (!url || !isResendDownloadUrl(url)) return null;
    if (typeof meta.size === "number" && meta.size > maxBytes) return null;
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new TransientError(`attachment ${res.status}`);
    const bytes = await readCapped(res, maxBytes);
    if (!bytes) return null;
    return { bytes, contentType: str(meta.content_type) ?? res.headers.get("content-type"), filename: str(meta.filename) };
  },
};

