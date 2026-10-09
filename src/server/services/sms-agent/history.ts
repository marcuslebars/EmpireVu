/**
 * The conversation as the agent sees it: the last ~20 texts with this customer (both ways),
 * each marked customer / assistant (the AI) / staff (a person or an automation).
 */
import type { AdminClient, InboundMedia } from "@/server/services/front-desk/contracts";
import { readMediaColumn } from "@/server/services/sms-agent/media";
import type { HistoryMessage } from "@/server/services/sms-agent/prompt";
import { SMS_AGENT_SENDER } from "@/server/services/sms-agent/services";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface LoggedMessage extends HistoryMessage {
  media: InboundMedia[];
}

interface MessageLogRow {
  id: string;
  created_at: string;
  direction: string;
  body: string | null;
  status: string;
  sent_by: string | null;
  media: unknown;
}

export async function loadHistory(
  admin: AdminClient,
  key: { organizationId: string; contactId: string },
  limit = 20,
): Promise<LoggedMessage[]> {
  const { data, error } = await (admin as Db)
    .from("message_log")
    .select("id, created_at, direction, body, status, sent_by, media")
    .eq("organization_id", key.organizationId)
    .eq("contact_id", key.contactId)
    .eq("channel", "sms")
    .in("status", ["sent", "received"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = ((data ?? []) as MessageLogRow[])
    .slice()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(-limit);
  return rows.map((r) => {
    const media = r.direction === "inbound" ? readMediaColumn(r.media) : [];
    return {
      id: r.id,
      at: r.created_at,
      from: r.direction === "inbound" ? "customer" : r.sent_by === SMS_AGENT_SENDER ? "assistant" : "staff",
      body: r.body ?? "",
      pictures: media.length,
      media,
    };
  });
}

/**
 * The customer texts this turn answers: inbound after the last one a turn handled — or, on a
 * conversation's first turn, inbound after the last outbound (at most 5). PURE.
 */
export function newCustomerMessages(history: LoggedMessage[], lastHandledAt: string | null): LoggedMessage[] {
  if (lastHandledAt) return history.filter((m) => m.from === "customer" && isAfter(m.at, lastHandledAt)).slice(-5);
  const lastOutbound = [...history].reverse().find((m) => m.from !== "customer");
  return history.filter((m) => m.from === "customer" && (!lastOutbound || isAfter(m.at, lastOutbound.at))).slice(-5);
}

/** Timestamp order across formats (PostgREST "+00:00" vs JS "Z"). */
export function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

/** Is there a customer text newer than `since`? (picks up texts that arrived mid-turn) */
export async function hasInboundAfter(
  admin: AdminClient,
  key: { organizationId: string; contactId: string },
  since: string | null,
): Promise<boolean> {
  let query = (admin as Db)
    .from("message_log")
    .select("id")
    .eq("organization_id", key.organizationId)
    .eq("contact_id", key.contactId)
    .eq("channel", "sms")
    .eq("direction", "inbound");
  if (since) query = query.gt("created_at", since);
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0;
}

/** AI replies sent in the last 24h — to one customer, and across the company. */
export async function countAiReplies(
  admin: AdminClient,
  key: { organizationId: string; companyId: string; contactId: string },
  now: Date,
): Promise<{ conversation: number; company: number }> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const base = () =>
    (admin as Db)
      .from("message_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", key.organizationId)
      .eq("company_id", key.companyId)
      .eq("sent_by", SMS_AGENT_SENDER)
      .eq("status", "sent")
      .gte("created_at", since);
  const [conv, company] = await Promise.all([base().eq("contact_id", key.contactId), base()]);
  if (conv.error) throw conv.error;
  if (company.error) throw company.error;
  return { conversation: conv.count ?? 0, company: company.count ?? 0 };
}
