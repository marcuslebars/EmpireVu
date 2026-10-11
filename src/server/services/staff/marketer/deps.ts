/**
 * The Marketer's seams (injectable in tests): the model, owner notification, the Google
 * reviews fetch, the (future) Google reply poster, and the clock. Plus the small shared
 * helpers every part uses: creating an approval, re-asking when the owner adds a note to a
 * kind that can't take one, and texting the owner.
 */
import type { Tables } from "@/server/db/database.types";
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient, ApprovalKind, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { sendOwnerSms } from "@/server/services/owner-channel/common";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import { defaultMarketerModel, type MarketerModel } from "@/server/services/staff/marketer/ai";
import type { Db } from "@/server/services/staff/marketer/db-types";
import { fetchPlaceReviews, type FetchedPlaceReviews } from "@/server/services/staff/marketer/google";

export interface PostReplyInput {
  organizationId: string;
  companyId: string;
  reviewName: string;
  reply: string;
}

export interface MarketerDeps {
  model: MarketerModel;
  notify(admin: AdminClient, approvalId: string): Promise<{ notified: boolean }>;
  fetchReviews(placeId: string): Promise<FetchedPlaceReviews | null>;
  /**
   * Publish a review reply on Google. There is no Google Business Profile API access yet, so
   * the default returns { posted: false } and the owner is texted the reply to paste. When GBP
   * access lands, implement it here (accounts.locations.reviews.updateReply).
   */
  postReply(input: PostReplyInput): Promise<{ posted: boolean }>;
  now(): number;
}

export const defaultMarketerDeps: MarketerDeps = {
  model: defaultMarketerModel,
  notify: (admin, id) => notifyOwnerOfApproval(admin, id),
  fetchReviews: (placeId) => fetchPlaceReviews(placeId),
  postReply: async () => ({ posted: false }),
  now: () => Date.now(),
};

export function withDeps(overrides: Partial<MarketerDeps> = {}): MarketerDeps {
  return { ...defaultMarketerDeps, ...overrides };
}

export const MARKETER_REQUESTED_BY = "marketer";

export interface NewMarketerApproval {
  organizationId: string;
  companyId: string;
  kind: ApprovalKind;
  summary: string;
  payload: Record<string, unknown>;
  ttlMs: number;
}

/** insertApproval (short code at insert) + notify (best-effort; the owner-channel sweep re-sends). */
export async function createMarketerApproval(admin: AdminClient, deps: MarketerDeps, input: NewMarketerApproval): Promise<Tables<"owner_approvals">> {
  const now = new Date(deps.now());
  const row = await insertApproval(admin, {
    organizationId: input.organizationId,
    companyId: input.companyId,
    contactId: null,
    conversationId: null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    requestedBy: MARKETER_REQUESTED_BY,
    createdAt: now,
    expiresAt: new Date(now.getTime() + input.ttlMs),
  });
  try {
    await deps.notify(admin, row.id);
  } catch (err) {
    console.error("[marketer] notify failed:", err instanceof Error ? err.message : err);
  }
  return row;
}

/**
 * The owner replied "Y 12 $700" to something that goes out exactly as written. Don't act and
 * don't guess: put the same item back in front of them under a fresh code. `relink` points the
 * campaign / review / post at the new approval (conditional on the old one, so it's once).
 */
export async function reaskWithoutNote(
  admin: AdminClient,
  deps: MarketerDeps,
  approval: OwnerApprovalRow,
  relink: (newApprovalId: string) => Promise<boolean>,
  what: string,
): Promise<ExecuteResult> {
  const fresh = await insertApproval(admin, {
    organizationId: approval.organization_id,
    companyId: approval.company_id,
    contactId: null,
    conversationId: null,
    kind: approval.kind,
    summary: approval.summary,
    payload: approval.payload,
    requestedBy: MARKETER_REQUESTED_BY,
    createdAt: new Date(deps.now()),
    expiresAt: new Date(Math.max(deps.now() + 3_600_000, Date.parse(approval.expires_at ?? "") || 0)),
  });
  if (!(await relink(fresh.id))) {
    await (admin as Db).from("owner_approvals").update({ status: "superseded" }).eq("id", fresh.id).eq("status", "pending");
    return { ok: false, message: `Nothing done - that ${what} was already handled.` };
  }
  try {
    await deps.notify(admin, fresh.id);
  } catch {
    // The owner-channel sweep re-sends.
  }
  return {
    ok: false,
    message: `Nothing sent yet - the ${what} goes out exactly as shown, so I can't change it from a note. Reply Y ${fresh.short_code ?? "?"} to approve it as written, or N ${fresh.short_code ?? "?"} to skip.`,
    detail: { reaskedAs: fresh.id },
  };
}

export interface OwnerContact {
  phone: string | null;
  platformBrand: string | null;
}

export async function loadOwnerContact(admin: AdminClient, scope: { organizationId: string; companyId: string }): Promise<OwnerContact> {
  const db = admin as Db;
  const { data } = await db
    .from("companies")
    .select("owner_phone_e164, owner_phone_verified_at")
    .eq("organization_id", scope.organizationId)
    .eq("id", scope.companyId)
    .maybeSingle();
  const row = data as { owner_phone_e164: string | null; owner_phone_verified_at: string | null } | null;
  const { data: org } = await db.from("organizations").select("platform_brand").eq("id", scope.organizationId).maybeSingle();
  const phone = row?.owner_phone_e164?.trim() && row.owner_phone_verified_at ? row.owner_phone_e164.trim() : null;
  return { phone, platformBrand: (org as { platform_brand?: string | null } | null)?.platform_brand ?? null };
}

/** Text the owner from the platform number (verified phone only). */
export async function textOwner(admin: AdminClient, scope: { organizationId: string; companyId: string }, body: string): Promise<"sent" | "failed" | "blocked" | "no_phone"> {
  const owner = await loadOwnerContact(admin, scope);
  if (!owner.phone) return "no_phone";
  const result = await sendOwnerSms(admin, { to: owner.phone, body, organizationId: scope.organizationId, companyId: scope.companyId, platformBrand: owner.platformBrand });
  return result.status;
}

export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** Was this a unique-violation (another worker claimed it first)? */
export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}
