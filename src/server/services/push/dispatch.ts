import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/server/db/database.types";
import { getApnsConfig, sendApns, type SendOutcome } from "@/server/services/push/apns";
import { getFcmConfig, sendFcm } from "@/server/services/push/fcm";

/**
 * Push fan-out. Resolves the recipients' non-revoked device tokens for the organization,
 * applies each user's notification preferences and quiet hours server-side, sends, and
 * revokes tokens the provider reports as unregistered. Never throws — a push failure must
 * not fail the work that produced it.
 */
export type PushCategory = "leads" | "drafts" | "payments" | "conflicts" | "workflow_failures" | "daily_digest";

export interface PushMessage {
  title: string;
  body: string;
  category: PushCategory;
  /** Urgent pushes ignore quiet hours (never category opt-outs). */
  urgent?: boolean;
  /** Deep link: opening the push sets org/company scope, then navigates. */
  data: { screen: string; recordId?: string | null; organizationId: string; companyId?: string | null };
}

export interface PushSenders {
  ios: ((token: string, message: PushMessage) => Promise<SendOutcome>) | null;
  android: ((token: string, message: PushMessage) => Promise<SendOutcome>) | null;
}

export interface DispatchResult {
  sent: number;
  skipped: number;
  failed: number;
  revoked: number;
}

type Admin = SupabaseClient<Database>;
type Prefs = Tables<"notification_preferences">;

const DEFAULT_PREFS: Pick<Prefs, PushCategory> = {
  leads: true,
  drafts: true,
  payments: true,
  conflicts: true,
  workflow_failures: false,
  daily_digest: true,
};

function flattenData(message: PushMessage): Record<string, string> {
  const data: Record<string, string> = { screen: message.data.screen, organizationId: message.data.organizationId, category: message.category };
  if (message.data.recordId) data.recordId = message.data.recordId;
  if (message.data.companyId) data.companyId = message.data.companyId;
  return data;
}

export function defaultSenders(env: NodeJS.ProcessEnv = process.env): PushSenders {
  const apns = getApnsConfig(env);
  const fcm = getFcmConfig(env);
  return {
    ios: apns ? (token, message) => sendApns(apns, token, { title: message.title, body: message.body, threadId: message.category, data: flattenData(message) }) : null,
    android: fcm ? (token, message) => sendFcm(fcm, token, { title: message.title, body: message.body, data: flattenData(message) }) : null,
  };
}

/** Minutes since local midnight in `timeZone`. */
function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function inQuietHours(prefs: Pick<Prefs, "quiet_hours_start" | "quiet_hours_end" | "timezone"> | undefined, now: Date, fallbackTimeZone: string): boolean {
  if (!prefs?.quiet_hours_start || !prefs.quiet_hours_end) return false;
  let timeZone = prefs.timezone || fallbackTimeZone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    timeZone = fallbackTimeZone;
  }
  const current = localMinutes(now, timeZone);
  const start = toMinutes(prefs.quiet_hours_start);
  const end = toMinutes(prefs.quiet_hours_end);
  // A window like 21:00 → 06:30 wraps midnight.
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export async function sendPushToOrganization(
  admin: Admin,
  organizationId: string,
  message: PushMessage,
  options: { recipientUserIds?: string[]; senders?: PushSenders; now?: Date } = {},
): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, failed: 0, revoked: 0 };
  const senders = options.senders ?? defaultSenders();
  if (!senders.ios && !senders.android) return result;

  try {
    let tokenQuery = admin
      .from("device_tokens")
      .select("id, token, platform, user_id")
      .eq("organization_id", organizationId)
      .is("revoked_at", null);
    if (options.recipientUserIds) {
      if (options.recipientUserIds.length === 0) return result;
      tokenQuery = tokenQuery.in("user_id", options.recipientUserIds);
    }
    const { data: tokens, error } = await tokenQuery;
    if (error || !tokens?.length) return result;

    const userIds = [...new Set(tokens.map((t) => t.user_id))];
    const { data: prefRows } = await admin
      .from("notification_preferences")
      .select("*")
      .eq("organization_id", organizationId)
      .in("user_id", userIds);
    const prefsByUser = new Map((prefRows ?? []).map((row) => [row.user_id, row]));

    const now = options.now ?? new Date();
    const fallbackTimeZone = process.env.BUSINESS_TIMEZONE || "America/Toronto";
    const unregistered: string[] = [];

    await Promise.all(
      tokens.map(async (row) => {
        const prefs = prefsByUser.get(row.user_id);
        const optedIn = (prefs ?? DEFAULT_PREFS)[message.category];
        if (!optedIn || (!message.urgent && inQuietHours(prefs, now, fallbackTimeZone))) {
          result.skipped += 1;
          return;
        }
        const send = row.platform === "ios" ? senders.ios : senders.android;
        if (!send) {
          result.skipped += 1;
          return;
        }
        const outcome = await send(row.token, message);
        if (outcome === "sent") result.sent += 1;
        else if (outcome === "unregistered") unregistered.push(row.id);
        else result.failed += 1;
      }),
    );

    if (unregistered.length) {
      await admin.from("device_tokens").update({ revoked_at: now.toISOString() }).in("id", unregistered);
      result.revoked = unregistered.length;
    }
  } catch (error) {
    console.error("[push] dispatch failed:", error instanceof Error ? error.message : error);
  }

  return result;
}
