import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Tables } from "@/server/db/database.types";

type Admin = SupabaseClient<Database>;

export const registerDeviceTokenSchema = z.object({
  token: z.string().trim().min(8).max(4096),
  platform: z.enum(["ios", "android"]),
  appVersion: z.string().trim().max(64).optional(),
});

export const revokeDeviceTokenSchema = z.object({
  token: z.string().trim().min(8).max(4096),
});

/**
 * Upsert by token. The caller's org membership is checked by the route first; the write
 * uses the service role because a token last registered by another user on this device
 * must move to the current user — RLS would (correctly) refuse that cross-user update.
 */
export async function registerDeviceToken(
  admin: Admin,
  input: { userId: string; organizationId: string } & z.output<typeof registerDeviceTokenSchema>,
): Promise<Pick<Tables<"device_tokens">, "id" | "platform" | "last_seen_at">> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("device_tokens")
    .upsert(
      {
        token: input.token,
        user_id: input.userId,
        organization_id: input.organizationId,
        platform: input.platform,
        app_version: input.appVersion ?? null,
        last_seen_at: now,
        revoked_at: null,
      },
      { onConflict: "token" },
    )
    .select("id, platform, last_seen_at")
    .single();

  if (error) throw error;
  return data;
}

/** Revoke on sign-out. Scoped to the caller's own rows. */
export async function revokeDeviceToken(admin: Admin, input: { userId: string; token: string }): Promise<{ revoked: boolean }> {
  const { data, error } = await admin
    .from("device_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token", input.token)
    .eq("user_id", input.userId)
    .is("revoked_at", null)
    .select("id");

  if (error) throw error;
  return { revoked: (data ?? []).length > 0 };
}
