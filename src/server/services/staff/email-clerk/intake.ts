/**
 * The webhook's half (docs/ai-staff.md → "Email inbox"): find the inbox the email was for, store it
 * once (unique Message-ID per inbox, unique provider id — a webhook retry is a no-op), fetch its
 * content, and return fast. Classification, attachments and drafting happen in the
 * `email_clerk:process` sweep (process.ts), never in the request.
 *
 * The tenant comes ONLY from our own inbox address the email was delivered to (looked up
 * server-side); nothing else in the payload can pick an organization or company.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, InboundEmailRow } from "./db-types";
import { emailClerkDeps } from "./deps";
import { findInboxFor } from "./inboxes";
import { asMessageId, htmlToText, MAX_TEXT_CHARS, messageIds, parseAddress, sanitizeHtml, threadKeyFor } from "./parse";
import type { FetchedEmail, InboundWebhookData } from "./provider";
import { emailClerkOn, inboundConfigured, loadEmailClerkCompany } from "./settings";

export type IntakeResult =
  | { status: "stored"; id: string; fetched: boolean }
  | { status: "duplicate"; id: string | null }
  | { status: "ignored"; reason: "not_configured" | "unknown_address" | "off" };

/** The headers the rules read (and the forwarding ones), each capped. Everything else is dropped. */
const KEPT_HEADERS = [
  "from",
  "message-id",
  "in-reply-to",
  "references",
  "auto-submitted",
  "precedence",
  "list-id",
  "list-unsubscribe",
  "x-autoreply",
  "x-autorespond",
  "x-autoresponder",
  "x-auto-response-suppress",
  "x-spam-flag",
  "x-spam-status",
  "content-type",
  "delivered-to",
  "x-original-to",
  "x-forwarded-to",
  "x-forwarded-for",
];

export function keptHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = headers[name];
    if (typeof v === "string" && v.trim()) out[name] = v.replace(/[\r\n]+/g, " ").slice(0, name === "references" ? 4000 : 400);
  }
  return out;
}

/** A fetched email → the columns it fills on inbound_emails. PURE. */
export function contentColumns(fetched: FetchedEmail, current: Pick<InboundEmailRow, "message_id">): Partial<InboundEmailRow> {
  const headers = keptHeaders(fetched.headers);
  const from = parseAddress(headers.from ?? fetched.from);
  const plain = fetched.text?.trim() ? fetched.text : htmlToText(fetched.html);
  const inReplyTo = asMessageId(headers["in-reply-to"]);
  const references = messageIds(headers.references);
  return {
    from_address: from.address ?? parseAddress(fetched.from).address,
    from_name: from.name,
    to_addresses: fetched.to.slice(0, 20),
    cc_addresses: fetched.cc.slice(0, 20),
    reply_to: parseAddress(fetched.replyTo[0]).address,
    subject: fetched.subject ? fetched.subject.replace(/[\r\n]+/g, " ").slice(0, 300) : null,
    text_body: plain ? plain.slice(0, MAX_TEXT_CHARS) : null,
    html_excerpt: sanitizeHtml(fetched.html),
    in_reply_to: inReplyTo,
    reference_ids: references,
    thread_key: threadKeyFor(current.message_id, inReplyTo, references),
    headers,
    auth: fetched.authentication,
    attachments_meta: fetched.attachments.slice(0, 30).map((a) => ({
      id: a.id,
      filename: a.filename ? a.filename.slice(0, 200) : null,
      content_type: a.contentType,
      size: a.size,
      inline: (a.disposition ?? "").toLowerCase() === "inline" || Boolean(a.contentId && (a.contentType ?? "").startsWith("image/")),
    })),
    status: "received",
  };
}

/** Fetch an email's content into its row (status new → received). False → try again later. */
export async function fetchContent(admin: AdminClient, row: Pick<InboundEmailRow, "id" | "provider_email_id" | "message_id">, opts: { duringPass?: boolean } = {}): Promise<boolean> {
  let fetched: FetchedEmail | null;
  try {
    fetched = await emailClerkDeps().provider.fetchEmail(row.provider_email_id);
  } catch (err) {
    console.error("[email-clerk] fetching the email failed:", err instanceof Error ? err.message : err);
    return false;
  }
  if (!fetched) {
    await (admin as Db).from("inbound_emails").update({ status: "ignored", locked_until: null, last_error: "gone at the provider" }).eq("id", row.id).in("status", ["new", "processing"]);
    return false;
  }
  // From the sweep the row stays `processing` (its lease); from the webhook it becomes `received`.
  const columns = { ...contentColumns(fetched, row), ...(opts.duringPass ? { status: "processing" as const } : {}) };
  const { error } = await (admin as Db).from("inbound_emails").update(columns).eq("id", row.id).eq("status", opts.duringPass ? "processing" : "new");
  if (error) throw error;
  return true;
}

/**
 * Store one `email.received` delivery. Throws only when the durable write fails (the route then
 * answers 500 so the provider retries).
 */
export async function receiveInboundEmail(admin: AdminClient, data: InboundWebhookData, nowMs: number = Date.now()): Promise<IntakeResult> {
  if (!inboundConfigured()) return { status: "ignored", reason: "not_configured" };
  // The envelope recipient (received_for) is where it was delivered; the headers only when it's missing.
  const inbox = await findInboxFor(admin, data.receivedFor.length ? data.receivedFor : [...data.to, ...data.cc, ...data.bcc]);
  if (!inbox) return { status: "ignored", reason: "unknown_address" };
  const company = await loadEmailClerkCompany(admin, inbox.organization_id, inbox.company_id);
  if (!emailClerkOn(company)) return { status: "ignored", reason: "off" };

  const db = admin as Db;
  const messageId = asMessageId(data.messageId) ?? `<${data.emailId}@inbound.invalid>`;
  const from = parseAddress(data.from);
  const nowIso = new Date(nowMs).toISOString();
  const { data: inserted, error } = await db
    .from("inbound_emails")
    .insert({
      organization_id: inbox.organization_id,
      company_id: inbox.company_id,
      inbox_id: inbox.id,
      provider: emailClerkDeps().provider.name,
      provider_email_id: data.emailId,
      message_id: messageId,
      from_address: from.address,
      from_name: from.name,
      to_addresses: data.to.slice(0, 20),
      cc_addresses: data.cc.slice(0, 20),
      subject: data.subject ? data.subject.replace(/[\r\n]+/g, " ").slice(0, 300) : null,
      reference_ids: [],
      attachments_meta: [],
      thread_key: messageId,
      received_at: data.createdAt && Number.isFinite(Date.parse(data.createdAt)) ? new Date(Date.parse(data.createdAt)).toISOString() : nowIso,
      status: "new",
      attempts: 0,
      reply_status: "none",
      owner_alert_status: "none",
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id, provider_email_id, message_id")
    .single();
  if (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const { data: existing } = await db.from("inbound_emails").select("id").eq("inbox_id", inbox.id).eq("message_id", messageId).maybeSingle();
    return { status: "duplicate", id: (existing as { id: string } | null)?.id ?? null };
  }
  const row = inserted as Pick<InboundEmailRow, "id" | "provider_email_id" | "message_id">;
  await db.from("email_inboxes").update({ last_received_at: nowIso }).eq("id", inbox.id);
  const fetched = await fetchContent(admin, row).catch((err: unknown) => {
    console.error("[email-clerk] storing the content failed:", err instanceof Error ? err.message : err);
    return false;
  });
  return { status: "stored", id: row.id, fetched };
}
