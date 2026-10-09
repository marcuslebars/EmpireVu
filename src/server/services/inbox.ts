import type { Database, Json } from "@/server/db/database.types";
import { getContactById } from "@/server/services/contacts";
import type { TenantServiceContext } from "@/server/services/shared";
import { markOwnerTakeover } from "@/server/services/sms-agent/takeover";
import { deliverMessage, type DeliverMessageResult } from "@/server/services/workflow-engine/messaging";
import { createSupabaseAdminClient } from "@/server/supabase/admin";

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
  return labelAiMessages(context, (data ?? []) as ConversationThreadItem[]);
}

/**
 * Mark outbound messages the AI front desk wrote (message_log.sent_by = 'sms_agent') with
 * metadata.sentBy, so the thread can label them "Assistant". Best-effort: the thread still
 * renders unlabelled if this lookup fails.
 */
async function labelAiMessages(context: TenantServiceContext, items: ConversationThreadItem[]): Promise<ConversationThreadItem[]> {
  const ids = items.filter((i) => i.kind === "message" && i.direction === "outbound").map((i) => i.id);
  if (ids.length === 0) return items;
  try {
    const { data, error } = await context.supabase
      .from("message_log")
      .select("id, sent_by")
      .eq("organization_id", context.organizationId)
      .in("id", ids);
    if (error) throw error;
    const by = new Map(((data ?? []) as Array<{ id: string; sent_by: string | null }>).filter((r) => r.sent_by).map((r) => [r.id, r.sent_by]));
    if (by.size === 0) return items;
    return items.map((i) => {
      const sentBy = by.get(i.id);
      if (!sentBy) return i;
      const metadata = i.metadata && typeof i.metadata === "object" && !Array.isArray(i.metadata) ? i.metadata : {};
      return { ...i, metadata: { ...metadata, sentBy } };
    });
  } catch (err) {
    console.error("[inbox] sent_by lookup failed:", err instanceof Error ? err.message : err);
    return items;
  }
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
export interface SendContactMessageDeps {
  /** A person texted the customer → the AI front desk steps back (sms-agent/takeover.ts). */
  markOwnerTakeover(input: { companyId: string; contactId: string }): Promise<unknown>;
}

const defaultSendDeps: SendContactMessageDeps = {
  // sms_conversations is service-role-only for writes; the contact was already resolved under
  // the caller's RLS above, so this only records that a member of its org replied by hand.
  markOwnerTakeover: (input) => markOwnerTakeover(createSupabaseAdminClient(), input),
};

export async function sendContactMessage(
  context: TenantServiceContext,
  contactId: string,
  input: SendContactMessageInput,
  deps: SendContactMessageDeps = defaultSendDeps,
): Promise<DeliverMessageResult> {
  const contact = await getContactById(context, contactId);
  const to = input.channel === "sms" ? contact.phone : contact.email;

  const result = await deliverMessage({
    context,
    channel: input.channel,
    to,
    body: input.body,
    subject: input.channel === "email" ? input.subject ?? "" : null,
    companyId: contact.company_id,
    contactId: contact.id,
    consentContact: contact,
  });

  // A manual text to the customer = owner takeover (the AI goes quiet for 72h). Best-effort.
  if (input.channel === "sms" && result.status === "sent" && contact.company_id) {
    try {
      await deps.markOwnerTakeover({ companyId: contact.company_id, contactId: contact.id });
    } catch (err) {
      console.error("[inbox] owner takeover mark failed:", err instanceof Error ? err.message : err);
    }
  }
  return result;
}
