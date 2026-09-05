import { createHash, randomBytes } from "node:crypto";

import type { Inserts, Tables } from "@/server/db/database.types";
import { insertRow, type TenantServiceContext } from "@/server/services/shared";
// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #1 (service role): intake-key resolution runs on the public
// /api/intake webhook (no session), so it looks a key up by hash through the service-role
// client, bypassing RLS. Confined to lead-intake. The tenant is taken FROM THE KEY ROW —
// nothing in the request payload can choose an org/company. The management functions below
// run on the caller's RLS client (admins manage / members read), not the service role.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";

const KEY_BYTES = 24;
const KEY_PREFIX = "evk_";

/** sha256 hex of the full key — the only form ever stored. */
export function hashIntakeKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

export interface GeneratedIntakeKey {
  key: string;
  keyPrefix: string;
  keyHash: string;
}

/** A fresh key: `evk_<48 hex>`. The full value is returned ONCE (only the hash is stored). */
export function generateIntakeKey(): GeneratedIntakeKey {
  const key = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;
  return { key, keyPrefix: key.slice(0, 8), keyHash: hashIntakeKey(key) };
}

export interface ResolvedIntakeKey {
  id: string;
  organizationId: string;
  companyId: string | null;
}

/**
 * Request-path resolution (service role): an active key → its pinned tenant, or null when
 * the key is unknown or revoked. Touches last_used_at best-effort (telemetry never fails
 * the intake).
 */
export async function resolveIntakeKey(key: string): Promise<ResolvedIntakeKey | null> {
  const trimmed = key.trim();
  if (!trimmed) return null;

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("intake_keys")
    .select("id, organization_id, company_id, active")
    .eq("key_hash", hashIntakeKey(trimmed))
    .maybeSingle();
  if (error) throw error;

  const row = data as
    | { id: string; organization_id: string; company_id: string | null; active: boolean }
    | null;
  if (!row || !row.active) {
    return null;
  }

  try {
    await admin.from("intake_keys").update({ last_used_at: new Date().toISOString() }).eq("id", row.id);
  } catch {
    // last_used_at is telemetry only.
  }

  return { id: row.id, organizationId: row.organization_id, companyId: row.company_id };
}

// ── Management (admins; RLS-enforced through the caller's client) ─────────────

export interface IntakeKeyView {
  id: string;
  companyId: string | null;
  keyPrefix: string;
  label: string | null;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

function toView(row: Tables<"intake_keys">): IntakeKeyView {
  return {
    id: row.id,
    companyId: row.company_id,
    keyPrefix: row.key_prefix,
    label: row.label,
    active: row.active,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export async function listIntakeKeys(context: TenantServiceContext): Promise<IntakeKeyView[]> {
  const { data, error } = await context.supabase
    .from("intake_keys")
    .select("*")
    .eq("organization_id", context.organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Tables<"intake_keys">[]).map(toView);
}

/** Create a key and return the FULL value once (never retrievable again) plus the view. */
export async function createIntakeKey(
  context: TenantServiceContext,
  input: { companyId?: string | null; label?: string | null },
): Promise<{ key: string; keyPrefix: string; view: IntakeKeyView }> {
  const generated = generateIntakeKey();
  const row: Inserts<"intake_keys"> = {
    organization_id: context.organizationId,
    company_id: input.companyId ?? null,
    key_prefix: generated.keyPrefix,
    key_hash: generated.keyHash,
    label: input.label ?? null,
    created_by: context.actorProfileId,
    active: true,
  };
  const inserted = await insertRow(context, "intake_keys", row);
  return { key: generated.key, keyPrefix: generated.keyPrefix, view: toView(inserted) };
}

export async function revokeIntakeKey(context: TenantServiceContext, id: string): Promise<void> {
  const { error } = await context.supabase
    .from("intake_keys")
    .update({ active: false })
    .eq("organization_id", context.organizationId)
    .eq("id", id);
  if (error) throw error;
}
