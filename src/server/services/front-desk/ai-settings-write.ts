/**
 * The one way to read-modify-write companies.ai_settings: each part of the front desk owns one
 * section (sms_agent, call_answering, weekly_report, owner_pause) and must never clobber a
 * concurrent write to another. The write is conditional on companies.updated_at being what we
 * read (optimistic), retried a few times — the same pattern as weekly-report/view.ts.
 */
import type { Json } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
import type { AdminClient } from "@/server/services/front-desk/contracts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type AiSettings = Record<string, unknown>;

function asRecord(value: unknown): AiSettings {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as AiSettings) } : {};
}

export class AiSettingsConflictError extends Error {
  constructor() {
    super("Could not save the settings (the company was being updated) - try again.");
  }
}

/**
 * Apply `mutate` to the company's current ai_settings and write it back only if nobody else
 * wrote the row meanwhile. Returns the settings written, or null when the company isn't found.
 */
export async function updateAiSettings(
  admin: AdminClient,
  scope: { organizationId: string; companyId: string },
  mutate: (current: AiSettings) => AiSettings,
  attempts = 4,
): Promise<AiSettings | null> {
  const db = admin as Db;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data, error } = await db
      .from("companies")
      .select("ai_settings, updated_at")
      .eq("organization_id", scope.organizationId)
      .eq("id", scope.companyId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as { ai_settings: Json; updated_at: string | null };
    const next = mutate(asRecord(row.ai_settings));
    let query = db
      .from("companies")
      .update({ ai_settings: toJson(next), updated_at: new Date(Math.max(Date.now(), Date.parse(row.updated_at ?? "") + 1 || Date.now())).toISOString() })
      .eq("organization_id", scope.organizationId)
      .eq("id", scope.companyId);
    query = row.updated_at ? query.eq("updated_at", row.updated_at) : query.is("updated_at", null);
    const { data: written, error: writeError } = await query.select("id");
    if (writeError) throw writeError;
    if (((written ?? []) as unknown[]).length > 0) return next;
  }
  throw new AiSettingsConflictError();
}
