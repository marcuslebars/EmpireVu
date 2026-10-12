/**
 * The `email_reply` executor (owner-channel decideApproval → registry → here). Idempotent: the
 * email's reply_status goes awaiting_owner → sending by a conditional update on the approval id
 * before anything is sent, so a re-run sends nothing.
 *
 *   Y      deliverMessage (channel email): to the sender's address, from the business name,
 *          Reply-To = the business inbox (their next reply comes back to us, into the thread),
 *          In-Reply-To / References = the inbound Message-ID chain, subject "Re: …",
 *          message_log.sent_by 'email_clerk'. Consent is checked (an email opt-out wins).
 *   N      nothing is sent; the email stays in the app inbox for the owner to answer by hand.
 *   expiry the same, and the owner is told.
 *   a note ("Y 12 $700") — the reply only goes out exactly as drafted; nothing is sent.
 */
import type { Tables } from "@/server/db/database.types";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { ctxFor } from "@/server/services/owner-channel/common";
import { deliverMessage } from "@/server/services/workflow-engine/messaging";
import type { Db, InboundEmailRow } from "./db-types";
import { senderLabel } from "./format";
import { loadInbox } from "./inboxes";
import { replySubject } from "./parse";
import { loadEmailClerkCompany, emailClerkOn } from "./settings";

export const EMAIL_SENT_BY = "email_clerk";

/** In-Reply-To / References for our reply (synthetic ids from a webhook without one are left out). PURE. */
export function threadingHeaders(row: Pick<InboundEmailRow, "message_id" | "reference_ids">): { "In-Reply-To"?: string; References?: string } {
  const id = row.message_id && !row.message_id.endsWith("@inbound.invalid>") ? row.message_id : null;
  if (!id) return {};
  const chain = [...(row.reference_ids ?? []).filter((r) => r !== id), id].slice(-10);
  return { "In-Reply-To": id, References: chain.join(" ") };
}

async function setReplyStatus(admin: AdminClient, row: InboundEmailRow, approvalId: string, from: string, to: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const { data } = await (admin as Db)
    .from("inbound_emails")
    .update({ reply_status: to, ...extra })
    .eq("id", row.id)
    .eq("approval_id", approvalId)
    .eq("reply_status", from)
    .select("id");
  return ((data ?? []) as unknown[]).length > 0;
}

export async function executeEmailReply(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision): Promise<ExecuteResult> {
  const code = approval.short_code ?? "?";
  const id = typeof approval.payload.inboundEmailId === "string" ? approval.payload.inboundEmailId : null;
  const db = admin as Db;
  const { data } = id
    ? await db.from("inbound_emails").select("*").eq("organization_id", approval.organization_id).eq("company_id", approval.company_id).eq("id", id).maybeSingle()
    : { data: null };
  const row = data as InboundEmailRow | null;
  if (!row || row.approval_id !== approval.id) return { ok: false, message: `#${code} isn't linked to an email any more, so nothing was sent.` };
  const who = senderLabel(row);

  if (!decision.approved) {
    const expired = decision.decidedVia === "expiry";
    await setReplyStatus(admin, row, approval.id, "awaiting_owner", expired ? "expired" : "skipped");
    return expired
      ? { ok: true, message: `No answer on #${code}, so the reply to ${who} wasn't sent. Their email is in your app inbox.` }
      : { ok: true, message: `OK - nothing sent. ${who}'s email is in your app inbox if you want to answer it yourself.` };
  }
  if (row.reply_status !== "awaiting_owner") {
    return { ok: true, message: row.reply_status === "sent" ? `The reply to ${who} already went out.` : `#${code} was already handled.` };
  }
  if (decision.ownerNote?.trim()) {
    await setReplyStatus(admin, row, approval.id, "awaiting_owner", "skipped");
    return { ok: false, message: `Nothing sent - #${code} only goes out exactly as drafted. To change it, answer ${who} from the app inbox.` };
  }

  const company = await loadEmailClerkCompany(admin, approval.organization_id, approval.company_id);
  if (!emailClerkOn(company)) {
    await setReplyStatus(admin, row, approval.id, "awaiting_owner", "skipped");
    return { ok: false, message: "The email inbox is off for this business, so nothing was sent." };
  }
  const inbox = await loadInbox(admin, company);
  const { data: contactData } = row.contact_id
    ? await db.from("contacts").select("*").eq("organization_id", company.organizationId).eq("id", row.contact_id).maybeSingle()
    : { data: null };
  const contact = contactData as Tables<"contacts"> | null;
  if (!inbox || !contact || !row.from_address || !row.draft_reply) {
    await setReplyStatus(admin, row, approval.id, "awaiting_owner", "failed");
    return { ok: false, message: `Couldn't send the reply to ${who} (the email or the customer is gone). Check the app inbox.` };
  }

  // Claim before sending: one send per approval.
  if (!(await setReplyStatus(admin, row, approval.id, "awaiting_owner", "sending"))) return { ok: true, message: `#${code} was already handled.` };

  const result = await deliverMessage({
    context: ctxFor(admin, company.organizationId),
    channel: "email",
    // Always the sender's own address (never a Reply-To the email asked for).
    to: row.from_address,
    subject: row.draft_subject ?? replySubject(row.subject),
    body: row.draft_reply,
    companyId: company.companyId,
    contactId: contact.id,
    consentContact: contact,
    fromName: company.name,
    replyTo: inbox.address,
    sentBy: EMAIL_SENT_BY,
    emailHeaders: threadingHeaders(row),
  });
  const nowIso = new Date().toISOString();
  if (result.status === "sent") {
    await setReplyStatus(admin, row, approval.id, "sending", "sent", { replied_at: nowIso });
    return { ok: true, message: `Sent your reply to ${who} (${row.from_address}).`, detail: { inboundEmailId: row.id } };
  }
  if (result.status === "blocked") {
    await setReplyStatus(admin, row, approval.id, "sending", "blocked");
    return { ok: false, message: result.reason === "opted_out" ? `Didn't send - ${who} unsubscribed from your emails.` : `Didn't send the reply to ${who} (${result.reason ?? "blocked"}).` };
  }
  // Failed: not retried (an ambiguous send could go out twice); the owner answers by hand.
  await setReplyStatus(admin, row, approval.id, "sending", "failed");
  return { ok: false, message: `Couldn't send the reply to ${who} - the email service didn't take it. Answer them from the app inbox.` };
}
