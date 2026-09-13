import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Tables } from "@/server/db/database.types";

type Client = SupabaseClient<Database, "public">;

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use HH:MM (24-hour).")
  .nullable();

export const updateNotificationPreferencesSchema = z
  .object({
    leads: z.boolean(),
    drafts: z.boolean(),
    payments: z.boolean(),
    conflicts: z.boolean(),
    workflowFailures: z.boolean(),
    dailyDigest: z.boolean(),
    quietHoursStart: time,
    quietHoursEnd: time,
    timezone: z.string().max(64).nullable(),
  })
  .partial();

export interface NotificationPreferencesView {
  leads: boolean;
  drafts: boolean;
  payments: boolean;
  conflicts: boolean;
  workflowFailures: boolean;
  dailyDigest: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
}

const DEFAULTS: NotificationPreferencesView = {
  leads: true,
  drafts: true,
  payments: true,
  conflicts: true,
  workflowFailures: false,
  dailyDigest: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
};

function toView(row: Tables<"notification_preferences"> | null): NotificationPreferencesView {
  if (!row) return DEFAULTS;
  return {
    leads: row.leads,
    drafts: row.drafts,
    payments: row.payments,
    conflicts: row.conflicts,
    workflowFailures: row.workflow_failures,
    dailyDigest: row.daily_digest,
    quietHoursStart: row.quiet_hours_start?.slice(0, 5) ?? null,
    quietHoursEnd: row.quiet_hours_end?.slice(0, 5) ?? null,
    timezone: row.timezone,
  };
}

/** Runs as the user (RLS: own rows only). */
export async function getNotificationPreferences(supabase: Client, userId: string, organizationId: string): Promise<NotificationPreferencesView> {
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return toView(data);
}

export async function updateNotificationPreferences(
  supabase: Client,
  userId: string,
  organizationId: string,
  input: z.output<typeof updateNotificationPreferencesSchema>,
): Promise<NotificationPreferencesView> {
  const current = await getNotificationPreferences(supabase, userId, organizationId);
  const next = { ...current, ...input };
  const { data, error } = await supabase
    .from("notification_preferences")
    .upsert(
      {
        user_id: userId,
        organization_id: organizationId,
        leads: next.leads,
        drafts: next.drafts,
        payments: next.payments,
        conflicts: next.conflicts,
        workflow_failures: next.workflowFailures,
        daily_digest: next.dailyDigest,
        quiet_hours_start: next.quietHoursStart,
        quiet_hours_end: next.quietHoursEnd,
        timezone: next.timezone,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,organization_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return toView(data);
}
