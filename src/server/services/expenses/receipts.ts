/**
 * SANCTIONED EXCEPTION (service role): receipt files.
 *
 * The `expense-receipts` bucket has no storage policies, so nobody can list or read it
 * with their own session. This module is the only way in, and every function takes an
 * organization id and refuses a path outside `{organizationId}/`:
 *   • createReceiptUpload — a one-time signed upload URL for a new receipt
 *   • signReceiptUrls     — short-lived read URLs, only for paths the caller already read
 *                           off expense rows they can see under RLS
 *   • downloadReceipt     — the bytes, for reading the receipt with AI
 *   • removeReceipt       — delete a replaced / deleted expense's file
 */
import { randomUUID } from "node:crypto";

import { ValidationError } from "@/server/organizations/context";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { receiptPathFor, receiptTypeOfPath, type ReceiptType } from "./rules";

export const RECEIPTS_BUCKET = "expense-receipts";
const READ_URL_TTL_SECONDS = 3600;
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

function assertOwnPath(organizationId: string, path: string): ReceiptType {
  const type = receiptTypeOfPath(organizationId, path);
  if (!type) throw new ValidationError("That receipt doesn't belong to this business.");
  return type;
}

export async function createReceiptUpload(
  organizationId: string,
  type: ReceiptType,
  receiptId: string = randomUUID(),
): Promise<{ path: string; token: string; type: ReceiptType }> {
  const path = receiptPathFor(organizationId, receiptId, type);
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.storage.from(RECEIPTS_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) throw error ?? new Error("Could not create an upload URL.");
  return { path, token: data.token, type };
}

export async function signReceiptUrls(organizationId: string, paths: string[]): Promise<Map<string, string>> {
  const own = [...new Set(paths.filter((p) => receiptTypeOfPath(organizationId, p)))];
  if (own.length === 0) return new Map();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.storage.from(RECEIPTS_BUCKET).createSignedUrls(own, READ_URL_TTL_SECONDS);
  if (error) {
    console.error("[expenses] could not sign receipt URLs:", error.message);
    return new Map();
  }
  const out = new Map<string, string>();
  for (const entry of data ?? []) if (entry.path && entry.signedUrl) out.set(entry.path, entry.signedUrl);
  return out;
}

/** True when the uploaded file is really there (an expense never points at nothing). */
export async function receiptExists(organizationId: string, path: string): Promise<boolean> {
  assertOwnPath(organizationId, path);
  const admin = createSupabaseAdminClient();
  const slash = path.lastIndexOf("/");
  const { data, error } = await admin.storage.from(RECEIPTS_BUCKET).list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 1 });
  if (error) throw error;
  return (data ?? []).some((o) => o.name === path.slice(slash + 1));
}

export async function downloadReceipt(organizationId: string, path: string): Promise<{ bytes: Buffer; type: ReceiptType }> {
  const type = assertOwnPath(organizationId, path);
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.storage.from(RECEIPTS_BUCKET).download(path);
  if (error || !data) throw new ValidationError("That receipt couldn't be found — try uploading it again.");
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length > MAX_RECEIPT_BYTES) throw new ValidationError("That receipt is too large to read (10 MB max).");
  return { bytes, type };
}

/** Best effort: a leftover file is harmless (private, unlisted), a failed delete never blocks the user. */
export async function removeReceipt(organizationId: string, path: string | null | undefined): Promise<void> {
  if (!path || !receiptTypeOfPath(organizationId, path)) return;
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.storage.from(RECEIPTS_BUCKET).remove([path]);
    if (error) console.error("[expenses] could not remove receipt:", error.message);
  } catch (err) {
    console.error("[expenses] could not remove receipt:", err instanceof Error ? err.message : err);
  }
}
