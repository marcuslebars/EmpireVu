import type { Database, Json } from "@/server/db/database.types";
import { getContactById } from "@/server/services/contacts";
import type { TenantServiceContext } from "@/server/services/shared";
import { deliverMessage, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";

/**
 * Unified conversation inbox read/write service (Task 12). Reads go through the
 * security-invoker read models (ui_inbox_v / ui_conversation_thread) so they carry the
 * caller's RLS; the composer sends through deliverMessage (consent + message_log).
 */

export interface InboxListOptions {
  companyId?: string | null;
  needsReply?: boolean;
  search?: string | null;
  limit?: number;
}

export type InboxRow = Database["public"]["Views"]["ui_inbox_v"]["Row"];

export async function getInboxList(
  context: TenantServiceContext,
  options: InboxListOptions = {},
): Promise<InboxRow[]> {
  let query = context.supabase
    .from("ui_inbox_v")
    .select("*")
    .eq("organization_id", context.organizationId);

  if (options.companyId) query = query.eq("company_id", options.companyId);
  if (options.needsReply) query = query.eq("needs_reply", true);
  if (options.search) {
    const sanitized = options.search.toLowerCase().replace(/[^a-z0-9 @.+-]/g, "").trim();
    if (sanitized) query = query.ilike("search_text", `%${sanitized}%`);
  }

  const { data, error } = await query
    .order("needs_reply", { ascending: false })
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .limit(options.limit ?? 100);

  if (error) throw error;
  return (data ?? []) as InboxRow[];
}

export type ConversationThreadItem = {
  id: string;
  kind: string;
  occurred_at: string;
  direction: string | null;
  channel: string | null;
  title: string | null;
  body: string | null;
  status: string | null;
  metadata: Json;
};

export interface ConversationThreadOptions {
  beforeTs?: string | null;
  limit?: number;
}

export async function getConversationThread(
  context: TenantServiceContext,
  contactId: string,
  options: ConversationThreadOptions = {},
): Promise<ConversationThreadItem[]> {
  const { data, error } = await context.supabase.rpc("ui_conversation_thread", {
    p_org_id: context.organizationId,
    p_contact_id: contactId,
    p_before_ts: options.beforeTs ?? undefined,
    p_limit: options.limit ?? 50,
  });
  if (error) throw error;
  return (data ?? []) as ConversationThreadItem[];
}

/** Mark a conversation read for the current user (upsert their read marker). */
export async function markContactRead(
  context: TenantServiceContext,
  contactId: string,
): Promise<{ lastReadAt: string }> {
  if (!context.actorProfileId) {
    throw new Error("Mark-read requires an authenticated user.");
  }
  const lastReadAt = new Date().toISOString();
  const { error } = await context.supabase
    .from("contact_read_state")
    .upsert(
      {
        organization_id: context.organizationId,
        contact_id: contactId,
        profile_id: context.actorProfileId,
        last_read_at: lastReadAt,
      },
      { onConflict: "contact_id,profile_id" },
    );
  if (error) throw error;
  return { lastReadAt };
}

export type SendContactMessageChannel = "sms" | "email";

export interface SendContactMessageInput {
  channel: SendContactMessageChannel;
  body: string;
  subject?: string | null;
}

/**
 * Send a message to a contact from the inbox composer. SMS and email both go through
 * deliverMessage, so consent is enforced (an opted-out / no-consent contact is refused and
 * the attempt is logged as `blocked`), message_log is written, and usage is metered.
 */
export async function sendContactMessage(
  context: TenantServiceContext,
  contactId: string,
  input: SendContactMessageInput,
): Promise<DeliverMessageResult> {
  const contact = await getContactById(context, contactId);
  const to = input.channel === "sms" ? contact.phone : contact.email;

  return deliverMessage({
    context,
    channel: input.channel,
    to,
    body: input.body,
    subject: input.channel === "email" ? input.subject ?? "" : null,
    companyId: contact.company_id,
    contactId: contact.id,
    consentContact: contact,
  });
}
