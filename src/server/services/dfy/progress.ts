// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): done-for-you progress rows (dfy_progress).
// Written only by the purchase provisioning (billing worker), the done-for-you sweep (worker
// scheduler) and the public one-tap forwarding routes (token-scoped). Every read/write is
// filtered by the row's own organization_id + company_id (never by request input other than
// an unguessable token, which resolves to exactly one row). docs/done-for-you.md.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";

import type { Tables, Updates } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/crankleads/purchases";

export type DfyProgress = Tables<"dfy_progress">;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** 32 random bytes, url-safe — the /forward/:token credential. */
export function newForwardToken(): string {
  return randomBytes(24).toString("base64url");
}

const FORWARD_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function isForwardToken(value: unknown): value is string {
  return typeof value === "string" && FORWARD_TOKEN.test(value);
}

export async function loadProgress(admin: AdminClient, organizationId: string, companyId: string): Promise<DfyProgress | null> {
  const { data, error } = await admin
    .from("dfy_progress")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new Error(`dfy_progress lookup failed: ${error.message}`);
  return (data as DfyProgress | null) ?? null;
}

/** The company's progress row, created on first use (idempotent; a racing insert just re-reads). */
export async function ensureProgress(admin: AdminClient, organizationId: string, companyId: string): Promise<DfyProgress> {
  const existing = await loadProgress(admin, organizationId, companyId);
  if (existing) return existing;
  const { error } = await admin
    .from("dfy_progress")
    .upsert({ organization_id: organizationId, company_id: companyId }, { onConflict: "company_id", ignoreDuplicates: true });
  if (error) throw new Error(`dfy_progress insert failed: ${error.message}`);
  const created = await loadProgress(admin, organizationId, companyId);
  if (!created) throw new Error("dfy_progress row missing after insert");
  return created;
}

export async function patchProgress(
  admin: AdminClient,
  row: Pick<DfyProgress, "organization_id" | "company_id">,
  patch: Updates<"dfy_progress">,
): Promise<void> {
  const { error } = await admin
    .from("dfy_progress")
    .update(patch)
    .eq("organization_id", row.organization_id)
    .eq("company_id", row.company_id);
  if (error) throw new Error(`dfy_progress update failed: ${error.message}`);
}

/**
 * Set `column` to now only if it is still null. True when THIS call set it (the
 * once-only guard for texts, escalations and switch-on).
 */
export async function claimOnce(
  admin: AdminClient,
  row: Pick<DfyProgress, "organization_id" | "company_id">,
  column: "forward_text_sent_at" | "escalated_at" | "switched_on_at" | "number_flagged_at" | "forward_help_requested_at",
  nowIso: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("dfy_progress")
    .update({ [column]: nowIso })
    .eq("organization_id", row.organization_id)
    .eq("company_id", row.company_id)
    .is(column, null)
    .select("company_id");
  if (error) throw new Error(`dfy_progress claim ${column} failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** The forwarding token for a company (minted once). */
export async function ensureForwardToken(admin: AdminClient, row: DfyProgress, mint: () => string = newForwardToken): Promise<string> {
  if (row.forward_token) return row.forward_token;
  const token = mint();
  const { error } = await admin
    .from("dfy_progress")
    .update({ forward_token: token })
    .eq("organization_id", row.organization_id)
    .eq("company_id", row.company_id)
    .is("forward_token", null);
  if (error) throw new Error(`forward token write failed: ${error.message}`);
  const latest = await loadProgress(admin, row.organization_id, row.company_id);
  return latest?.forward_token ?? token;
}

export async function findProgressByForwardToken(admin: AdminClient, token: string): Promise<DfyProgress | null> {
  if (!isForwardToken(token)) return null;
  const { data, error } = await admin.from("dfy_progress").select("*").eq("forward_token", token).maybeSingle();
  if (error) throw new Error(`forward token lookup failed: ${error.message}`);
  return (data as DfyProgress | null) ?? null;
}
