/**
 * Asking the owner: owner_approvals rows the owner answers by text ("Y 2", "N 2", "Y but $700").
 * The SMS agent creates them; the owner channel notifies and decides; approved.ts executes.
 */
import { insertApproval, nextShortCode } from "@/server/services/front-desk/approvals";
import type { AdminClient, ApprovalKind } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";

/** How long each kind waits for the owner. Booking-slot holds go stale sooner. */
export function approvalTtlMs(kind: ApprovalKind): number {
  if (kind === "book_job") return 4 * 3_600_000;
  if (kind === "callback") return 12 * 3_600_000;
  return 24 * 3_600_000;
}

export { nextShortCode };

export interface NewApproval {
  organizationId: string;
  companyId: string;
  contactId: string | null;
  conversationId: string | null;
  kind: ApprovalKind;
  summary: string;
  payload: Record<string, unknown>;
  /** The company's timezone — a booking for today is urgent (the owner is texted even at night). */
  timeZone?: string | null;
}

export interface CreatedApproval {
  id: string;
  shortCode: number;
  expiresAt: string;
}

export interface ApprovalDeps {
  notify(admin: AdminClient, approvalId: string): Promise<{ notified: boolean }>;
  now(): Date;
}

export const defaultApprovalDeps: ApprovalDeps = {
  notify: notifyOwnerOfApproval,
  now: () => new Date(),
};

function localDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * A booking approval for today: it can't wait for the morning, so the owner channel texts it
 * even in quiet hours (owner-channel/notify.ts isUrgentApproval reads payload.urgent). PURE.
 */
export function isSameDayBooking(kind: ApprovalKind, payload: Record<string, unknown>, now: Date, timeZone: string | null | undefined): boolean {
  if (kind !== "book_job") return false;
  const zone = timeZone?.trim() || "America/Toronto";
  const today = localDate(now, zone);
  const startsAt = typeof payload.startsAt === "string" ? new Date(payload.startsAt) : null;
  if (startsAt && Number.isFinite(startsAt.getTime())) return localDate(startsAt, zone) === today;
  return typeof payload.date === "string" && payload.date.slice(0, 10) === today;
}

/**
 * Create a pending approval through the shared insert (front-desk/approvals.ts — short code at
 * insert), then ask the owner. The notify step is best-effort: the row is the source of truth
 * and the owner channel's sweep re-sends.
 */
export async function createApproval(
  admin: AdminClient,
  input: NewApproval,
  deps: ApprovalDeps = defaultApprovalDeps,
): Promise<CreatedApproval> {
  const now = deps.now();
  const urgent = input.payload.urgent === true || isSameDayBooking(input.kind, input.payload, now, input.timeZone);
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    kind: input.kind,
    summary: input.summary,
    payload: urgent ? { ...input.payload, urgent: true } : input.payload,
    requestedBy: "sms_agent",
    createdAt: now,
    expiresAt: new Date(now.getTime() + approvalTtlMs(input.kind)),
  });
  try {
    await deps.notify(admin, row.id);
  } catch (err) {
    console.error("[sms-agent] notifyOwnerOfApproval failed:", err instanceof Error ? err.message : err);
  }
  return { id: row.id, shortCode: row.short_code ?? nextShortCode([]), expiresAt: row.expires_at ?? new Date(now.getTime() + approvalTtlMs(input.kind)).toISOString() };
}
