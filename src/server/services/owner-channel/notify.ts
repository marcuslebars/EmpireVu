import type { Tables } from "@/server/db/database.types";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { ensureShortCodes, expireApproval, isExpired } from "./approvals";
import { DEFAULT_TIMEZONE, findOwnerCompanies, isQuietHours, sendOwnerSms } from "./common";

/**
 * Approval kinds that may text the owner during quiet hours (21:00–08:00 company local).
 * Anything else waits for the morning. A requester can also set payload.urgent = true
 * (e.g. a same-day booking request that would be gone by 8am).
 */
export const URGENT_APPROVAL_KINDS = new Set(["same_day_booking", "urgent_callback", "emergency"]);

type ApprovalDbRow = Tables<"owner_approvals">;

export function isUrgentApproval(row: Pick<ApprovalDbRow, "kind" | "payload">): boolean {
  if (URGENT_APPROVAL_KINDS.has(row.kind)) return true;
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
  return payload.urgent === true;
}

/**
 * Text the owner about a pending owner_approvals row ("Quote for Dana: $650. Reply Y to approve,
 * N to skip"), from the platform number. Idempotent: claims notified_at before sending (a
 * second call is a no-op) and releases it only if the send itself failed, so the sweep retries.
 * Quiet hours: non-urgent approvals wait (the sweep sends them at 08:00). Never throws.
 */
export async function notifyOwnerOfApproval(admin: AdminClient, approvalId: string, options: { nowMs?: number } = {}): Promise<{ notified: boolean }> {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const { data } = await admin.from("owner_approvals").select("*").eq("id", approvalId).maybeSingle();
    const row = data as ApprovalDbRow | null;
    if (!row || row.status !== "pending" || row.notified_at || isExpired(row, nowMs)) return { notified: false };

    const { data: companyData } = await admin
      .from("companies")
      .select("id, organization_id, name, timezone, owner_phone_e164, owner_phone_verified_at")
      .eq("organization_id", row.organization_id)
      .eq("id", row.company_id)
      .maybeSingle();
    const company = companyData as Pick<Tables<"companies">, "id" | "organization_id" | "name" | "timezone" | "owner_phone_e164" | "owner_phone_verified_at"> | null;
    const ownerPhone = company?.owner_phone_e164?.trim();
    // Only a verified owner phone can answer approvals; an unverified one waits (the app card works).
    if (!company || !ownerPhone || !company.owner_phone_verified_at) return { notified: false };

    const timeZone = company.timezone?.trim() || DEFAULT_TIMEZONE;
    if (isQuietHours(nowMs, timeZone) && !isUrgentApproval(row)) return { notified: false };

    // Claim: only one caller gets to send.
    const { data: claimed } = await admin
      .from("owner_approvals")
      .update({ notified_at: new Date(nowMs).toISOString(), notified_to: ownerPhone })
      .eq("id", row.id)
      .eq("status", "pending")
      .is("notified_at", null)
      .select("id");
    if ((claimed ?? []).length === 0) return { notified: false };

    await ensureShortCodes(admin, row.company_id);
    const { data: fresh } = await admin.from("owner_approvals").select("short_code").eq("id", row.id).maybeSingle();
    const code = (fresh as { short_code: number | null } | null)?.short_code ?? row.short_code ?? null;
    const owned = await findOwnerCompanies(admin, ownerPhone);
    const where = owned.length > 1 ? `${company.name}: ` : "";
    const brand = owned.find((c) => c.companyId === row.company_id)?.platformBrand ?? null;
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
    // The code is always shown (codes never repeat within a week), so a late "Y 12" can only
    // ever mean this item.
    const body = `${where}#${code ?? "?"} ${row.summary.trim()} ${replyInstruction(row.kind, code, payload)}`;

    const sent = await sendOwnerSms(admin, { to: ownerPhone, body, organizationId: row.organization_id, companyId: row.company_id, platformBrand: brand });
    if (sent.status === "failed") {
      await admin.from("owner_approvals").update({ notified_at: null, notified_to: null }).eq("id", row.id).eq("status", "pending");
      return { notified: false };
    }
    // "blocked" (owner opted out of platform texts): leave it claimed — it's on the app list.
    return { notified: sent.status === "sent" };
  } catch (err) {
    console.error("[owner-channel] notify failed", approvalId, err instanceof Error ? err.message : err);
    return { notified: false };
  }
}

/**
 * Scheduler pass (every tick, cheap): (a) expire approvals past expires_at — status 'expired',
 * decided_via 'expiry', and the executor runs with approved:false so the customer isn't left
 * hanging; (b) text the owner about pending approvals that were never sent (quiet hours ended,
 * or a send failed). Both are claim-based, so overlapping workers are safe.
 */
export async function sweepOwnerApprovals(admin: AdminClient, nowMs: number = Date.now()): Promise<{ expired: number; notified: number }> {
  let expired = 0;
  let notified = 0;
  const nowIso = new Date(nowMs).toISOString();

  const { data: due } = await admin
    .from("owner_approvals")
    .select("*")
    .eq("status", "pending")
    .lte("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(50);
  for (const row of (due ?? []) as ApprovalDbRow[]) {
    if (!isExpired(row, nowMs)) continue;
    const result = await expireApproval(admin, row, nowMs).catch((err: unknown) => {
      console.error("[owner-channel] expiry failed", row.id, err instanceof Error ? err.message : err);
      return null;
    });
    if (result?.outcome === "expired") expired++;
  }

  const { data: unsent } = await admin
    .from("owner_approvals")
    .select("id, expires_at")
    .eq("status", "pending")
    .is("notified_at", null)
    .order("created_at", { ascending: true })
    .limit(50);
  for (const row of (unsent ?? []) as Array<Pick<ApprovalDbRow, "id" | "expires_at">>) {
    if (isExpired(row, nowMs)) continue;
    if ((await notifyOwnerOfApproval(admin, row.id, { nowMs })).notified) notified++;
  }

  return { expired, notified };
}
