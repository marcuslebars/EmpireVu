/**
 * The Dispatcher's owner approvals (kinds weather_reschedule, fill_gap, bulk_reschedule): the
 * shared insert (front-desk/approvals.ts — short code at insert) and then the owner channel's
 * notify (platform number, quiet hours 21:00–08:00 respected — a non-urgent ask waits for the
 * morning sweep). Owner-initiated asks (move_day) are answered inline by the owner agent, so
 * they're stamped as already texted to that phone (notified_to) and not re-sent.
 */
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";

export const WEATHER_RESCHEDULE_KIND = "weather_reschedule";
export const FILL_GAP_KIND = "fill_gap";
export const BULK_RESCHEDULE_KIND = "bulk_reschedule";

export interface DispatchApprovalInput {
  organizationId: string;
  companyId: string;
  contactId?: string | null;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  /** Owner-initiated (the owner agent relays the ask in its reply): the phone that asked. */
  askedInlineTo?: string | null;
}

export interface DispatchApprovalDeps {
  notify(admin: AdminClient, approvalId: string): Promise<{ notified: boolean }>;
  now(): Date;
}

export const defaultDispatchApprovalDeps: DispatchApprovalDeps = {
  notify: (admin, id) => notifyOwnerOfApproval(admin, id),
  now: () => new Date(),
};

export async function createDispatchApproval(
  admin: AdminClient,
  input: DispatchApprovalInput,
  deps: DispatchApprovalDeps = defaultDispatchApprovalDeps,
): Promise<{ id: string; shortCode: number | null; summary: string }> {
  const now = deps.now();
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    requestedBy: "dispatcher",
    createdAt: now,
    expiresAt: input.expiresAt,
    notifiedAt: input.askedInlineTo ? now : null,
    notifiedTo: input.askedInlineTo ?? null,
  });
  if (!input.askedInlineTo) {
    try {
      await deps.notify(admin, row.id);
    } catch (err) {
      console.error("[dispatcher] notifyOwnerOfApproval failed:", err instanceof Error ? err.message : err);
    }
  }
  return { id: row.id, shortCode: row.short_code ?? null, summary: row.summary };
}
