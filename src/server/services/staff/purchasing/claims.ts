/**
 * Claims that keep overlapping workers (and the owner's own order_materials) from doing the same
 * thing twice (docs/ai-staff.md → "Purchasing"):
 *
 *   purchase_order_drafts      one row per job (unique booking_id). Claimed `working` before any
 *                              work; a `failed` one is re-claimable after 30 min (3 tries), a
 *                              `working` one left by a dead worker after 15 min. The owner's
 *                              order_materials re-claims any finished one (they asked).
 *   purchasing_daily_counts    one row per company per local day: the questions the draft sweep
 *                              asked. A slot is reserved by a conditional increment BEFORE drafting
 *                              and released if nothing was asked, so `max_per_day` holds across workers.
 *
 * The last line of defence is the partial unique index on purchase_orders(booking_id) for open
 * orders (orders.ts AlreadyOrderedError).
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, PurchaseOrderDraftRow } from "./db-types";
import type { PurchasingCompany } from "./settings";

export const RETRY_AFTER_MS = 30 * 60_000;
export const STALE_WORKING_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 3;

/** Can this claim row be taken now? PURE. */
export function claimable(row: Pick<PurchaseOrderDraftRow, "outcome" | "attempts" | "updated_at">, nowMs: number, opts: { owner?: boolean } = {}): boolean {
  const age = nowMs - Date.parse(row.updated_at);
  if (row.outcome === "working") return age >= STALE_WORKING_MS;
  if (opts.owner) return true;
  return row.outcome === "failed" && row.attempts < MAX_ATTEMPTS && age >= RETRY_AFTER_MS;
}

/** Claim a job for drafting. Null → someone else has it (or it's done and this isn't the owner asking). */
export async function claimDraft(
  admin: AdminClient,
  company: Pick<PurchasingCompany, "organizationId" | "companyId">,
  bookingId: string,
  nowMs: number,
  opts: { owner?: boolean; existing?: PurchaseOrderDraftRow | null } = {},
): Promise<PurchaseOrderDraftRow | null> {
  const db = admin as Db;
  const nowIso = new Date(nowMs).toISOString();
  let existing = opts.existing;
  if (existing === undefined) {
    const { data, error } = await db.from("purchase_order_drafts").select("*").eq("company_id", company.companyId).eq("booking_id", bookingId).maybeSingle();
    if (error) throw error;
    existing = (data as PurchaseOrderDraftRow | null) ?? null;
  }
  if (!existing) {
    const { data, error } = await db
      .from("purchase_order_drafts")
      .insert({ organization_id: company.organizationId, company_id: company.companyId, booking_id: bookingId, outcome: "working", attempts: 1, created_at: nowIso, updated_at: nowIso })
      .select("*")
      .single();
    if (!error) return data as PurchaseOrderDraftRow;
    if ((error as { code?: string }).code !== "23505") throw error;
    return opts.owner ? claimDraft(admin, company, bookingId, nowMs, { owner: true }) : null;
  }
  if (!claimable(existing, nowMs, opts)) return null;
  const { data } = await db
    .from("purchase_order_drafts")
    .update({ outcome: "working", attempts: existing.attempts + 1, updated_at: nowIso })
    .eq("id", existing.id)
    .eq("outcome", existing.outcome)
    .eq("updated_at", existing.updated_at)
    .select("*");
  return ((data ?? []) as PurchaseOrderDraftRow[])[0] ?? null;
}

/** Record how a claimed draft ended. */
export async function finishDraft(admin: AdminClient, claimId: string, outcome: "asked" | "no_materials" | "already_ordered" | "failed", fields: { poId?: string | null; error?: string | null }, nowMs: number): Promise<void> {
  await (admin as Db)
    .from("purchase_order_drafts")
    .update({ outcome, purchase_order_id: fields.poId ?? null, last_error: fields.error ? fields.error.slice(0, 500) : null, updated_at: new Date(nowMs).toISOString() })
    .eq("id", claimId);
}

// ── The daily cap ────────────────────────────────────────────────────────────────

interface CountRow {
  id: string;
  asked: number;
}

/** Take one of today's `max` question slots. False → the cap is reached. */
export async function reserveDailySlot(admin: AdminClient, company: Pick<PurchasingCompany, "organizationId" | "companyId">, localDateKey: string, max: number): Promise<boolean> {
  const db = admin as Db;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db.from("purchasing_daily_counts").select("id, asked").eq("company_id", company.companyId).eq("local_date", localDateKey).maybeSingle();
    if (error) throw error;
    const row = data as CountRow | null;
    if (!row) {
      if (max < 1) return false;
      const { error: insErr } = await db.from("purchasing_daily_counts").insert({ organization_id: company.organizationId, company_id: company.companyId, local_date: localDateKey, asked: 1 });
      if (!insErr) return true;
      if ((insErr as { code?: string }).code !== "23505") throw insErr;
      continue;
    }
    if (row.asked >= max) return false;
    const { data: hit } = await db.from("purchasing_daily_counts").update({ asked: row.asked + 1 }).eq("id", row.id).eq("asked", row.asked).select("id");
    if (((hit ?? []) as unknown[]).length > 0) return true;
  }
  return false;
}

/** Give a slot back (the draft asked nothing). */
export async function releaseDailySlot(admin: AdminClient, companyId: string, localDateKey: string): Promise<void> {
  const db = admin as Db;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data } = await db.from("purchasing_daily_counts").select("id, asked").eq("company_id", companyId).eq("local_date", localDateKey).maybeSingle();
    const row = data as CountRow | null;
    if (!row || row.asked <= 0) return;
    const { data: hit } = await db.from("purchasing_daily_counts").update({ asked: row.asked - 1 }).eq("id", row.id).eq("asked", row.asked).select("id");
    if (((hit ?? []) as unknown[]).length > 0) return;
  }
}
