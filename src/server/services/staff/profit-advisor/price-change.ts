/**
 * Approval kind `price_change` (docs/ai-staff.md → "Profit advisor"): the monthly pricing check
 * asks the owner to raise ONE price-list item's price; nothing changes without the owner's Y.
 *
 *   Ask   a price_changes row (status proposed; one open per item — partial unique index) → the
 *         owner_approvals row (inserted already "notified to nobody", linked, then opened and texted
 *         through notifyOwnerOfApproval, so a Y can never land on an unlinked question).
 *   Y     claim proposed → applying (conditional on the approval id), re-check the cap (+15%, never
 *         a cut), then the price-list write — the service-role twin of quotes/catalog-items.ts
 *         updateCatalogItemPrices (rate, minimum, a priced item is active), CONDITIONAL on the price
 *         still being the one the owner saw. Recorded as applied (applied_at) so the next check
 *         shows the effect. Someone changed the price meanwhile → stale, nothing written.
 *   N     declined (counts toward the 90-day rule: not asked again for 90 days).
 *   expiry  expired (may be asked again next month).
 *   note  ("Y 12 $199" can't reach here from a text — the owner channel refuses a price on this
 *         kind — but from any other caller) nothing changes; asked again inline under a fresh code.
 */
import { replyInstruction } from "@/server/services/front-desk/approval-text";
import { insertApproval } from "@/server/services/front-desk/approvals";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { notifyOwnerOfApproval } from "@/server/services/owner-channel/notify";
import type { Db, PriceChangeBasis, PriceChangeRow } from "./db-types";
import { MAX_RAISE, priceChangeSummary, priceText, type ItemStats, type Proposal } from "./pricing";
import type { ProfitCompany } from "./settings";

export const PRICE_CHANGE_KIND = "price_change";
export const PRICE_CHANGE_TTL_MS = 7 * 86_400_000;

export interface PriceChangeDeps {
  notify: (admin: AdminClient, approvalId: string, nowMs: number) => Promise<{ notified: boolean }>;
}

export const defaultPriceChangeDeps: PriceChangeDeps = {
  notify: (admin, id, nowMs) => notifyOwnerOfApproval(admin, id, { nowMs }),
};

const errCode = (e: unknown) => (e && typeof e === "object" ? (e as { code?: string }).code : undefined);

export function basisOf(s: Pick<ItemStats, "jobs" | "margin" | "quotes" | "winRate">, companyMargin: number, windowDays: number): PriceChangeBasis {
  return {
    jobs: s.jobs,
    marginPct: Math.round((s.margin ?? 0) * 100),
    companyMarginPct: Math.round(companyMargin * 100),
    quotes: s.quotes,
    winRatePct: s.winRate != null ? Math.round(s.winRate * 100) : null,
    windowDays,
  };
}

/**
 * Ask the owner about one proposal. Returns the approval id, or null when it wasn't asked (an open
 * question for the item already exists, or a write failed — nothing is left half-made).
 */
export async function askPriceChange(
  admin: AdminClient,
  company: Pick<ProfitCompany, "organizationId" | "companyId">,
  input: { proposal: Proposal; stats: Pick<ItemStats, "jobs" | "margin" | "quotes" | "winRate">; companyMargin: number; windowDays: number; runKey: string },
  nowMs: number,
  deps: PriceChangeDeps = defaultPriceChangeDeps,
): Promise<string | null> {
  const db = admin as Db;
  const p = input.proposal;
  const { data: inserted, error } = await db
    .from("price_changes")
    .insert({
      organization_id: company.organizationId,
      company_id: company.companyId,
      service_catalog_item_id: p.itemId,
      item_label: p.label,
      pricing_type: p.pricingType,
      unit_label: p.unitLabel,
      status: "proposed",
      old_rate_cents: p.oldRateCents,
      new_rate_cents: p.newRateCents,
      old_minimum_cents: p.oldMinimumCents,
      new_minimum_cents: p.newMinimumCents,
      pct: p.pct,
      basis: basisOf(input.stats, input.companyMargin, input.windowDays),
      run_key: input.runKey,
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    })
    .select("*");
  if (error) {
    if (errCode(error) === "23505") return null; // already an open question for this item
    throw error;
  }
  const change = ((inserted ?? []) as PriceChangeRow[])[0];
  if (!change) return null;
  const now = new Date(nowMs);
  let approvalId: string;
  try {
    const row = await insertApproval(admin, {
      organizationId: company.organizationId,
      companyId: company.companyId,
      kind: PRICE_CHANGE_KIND,
      summary: priceChangeSummary(p, input.stats, input.companyMargin),
      payload: { priceChangeId: change.id, itemId: p.itemId, oldRateCents: p.oldRateCents, newRateCents: p.newRateCents },
      requestedBy: "profit_advisor",
      createdAt: now,
      expiresAt: new Date(nowMs + PRICE_CHANGE_TTL_MS),
      // Held (notified to nobody) until it's linked, so no sweep can text it first.
      notifiedAt: now,
      notifiedTo: null,
    });
    approvalId = row.id;
  } catch (err) {
    await db.from("price_changes").update({ status: "failed", result: "couldn't create the question" }).eq("id", change.id);
    throw err;
  }
  const { data: linked, error: linkErr } = await db.from("price_changes").update({ approval_id: approvalId }).eq("id", change.id).is("approval_id", null).select("id");
  if (linkErr || ((linked ?? []) as unknown[]).length === 0) {
    await admin.from("owner_approvals").update({ status: "superseded" }).eq("id", approvalId).eq("status", "pending");
    await db.from("price_changes").update({ status: "failed", result: "couldn't link the question" }).eq("id", change.id);
    return null;
  }
  await admin.from("owner_approvals").update({ notified_at: null, notified_to: null }).eq("id", approvalId).eq("status", "pending");
  await deps.notify(admin, approvalId, nowMs);
  return approvalId;
}

async function changeFor(admin: AdminClient, approval: OwnerApprovalRow): Promise<PriceChangeRow | null> {
  const db = admin as Db;
  const { data, error } = await db.from("price_changes").select("*").eq("organization_id", approval.organization_id).eq("company_id", approval.company_id).eq("approval_id", approval.id).maybeSingle();
  if (error) throw error;
  return (data as PriceChangeRow | null) ?? null;
}

const asProposal = (c: PriceChangeRow): Pick<Proposal, "pricingType" | "unitLabel"> => ({ pricingType: c.pricing_type, unitLabel: c.unit_label });

/** Ask again, inline, under a fresh code (the same change, exactly as shown). */
async function askAgain(admin: AdminClient, approval: OwnerApprovalRow, change: PriceChangeRow, decision: ApprovalDecision, nowMs: number): Promise<ExecuteResult> {
  const db = admin as Db;
  const phone = decision.decidedVia === "sms" && decision.decidedBy?.startsWith("+") ? decision.decidedBy : null;
  const row = await insertApproval(admin, {
    organizationId: approval.organization_id,
    companyId: approval.company_id,
    kind: PRICE_CHANGE_KIND,
    summary: approval.summary,
    payload: approval.payload,
    requestedBy: "profit_advisor",
    createdAt: new Date(nowMs),
    expiresAt: new Date(nowMs + PRICE_CHANGE_TTL_MS),
    notifiedAt: new Date(nowMs),
    notifiedTo: phone,
  });
  const { data: moved } = await db.from("price_changes").update({ approval_id: row.id }).eq("id", change.id).eq("approval_id", approval.id).eq("status", "proposed").select("id");
  if (((moved ?? []) as unknown[]).length === 0) {
    await admin.from("owner_approvals").update({ status: "superseded" }).eq("id", row.id).eq("status", "pending");
    return { ok: false, message: `Nothing changed on ${change.item_label}.` };
  }
  const code = row.short_code ?? null;
  return {
    ok: false,
    message: `Nothing changed yet - #${approval.short_code ?? "?"} only raises ${change.item_label} to exactly ${priceText(change.new_rate_cents, asProposal(change))} (+${change.pct}%). For another price, change it in your price list. #${code ?? "?"} ${replyInstruction(PRICE_CHANGE_KIND, code)}`,
  };
}

export async function executePriceChange(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, nowMs = Date.now()): Promise<ExecuteResult> {
  const db = admin as Db;
  const change = await changeFor(admin, approval);
  if (!change) return { ok: false, message: `#${approval.short_code ?? "?"} isn't linked to a price change any more, so nothing changed.` };
  const old = priceText(change.old_rate_cents, asProposal(change));
  const next = priceText(change.new_rate_cents, asProposal(change));
  const at = new Date(nowMs).toISOString();

  if (!decision.approved) {
    const expired = decision.decidedVia === "expiry";
    await db
      .from("price_changes")
      .update({ status: expired ? "expired" : "declined", decided_at: at, result: expired ? "no answer" : "owner said no" })
      .eq("id", change.id)
      .eq("approval_id", approval.id)
      .eq("status", "proposed");
    return expired
      ? { ok: true, message: `No answer on the ${change.item_label} price, so it stays at ${old}.` }
      : { ok: true, message: `OK - ${change.item_label} stays at ${old}. I won't ask about it again for 90 days.` };
  }

  if (decision.ownerNote?.trim()) {
    if (change.status !== "proposed") return { ok: false, message: `#${approval.short_code ?? "?"} was already handled - nothing changed.` };
    return askAgain(admin, approval, change, decision, nowMs);
  }

  const { data: claimed } = await db.from("price_changes").update({ status: "applying", decided_at: at }).eq("id", change.id).eq("approval_id", approval.id).eq("status", "proposed").select("id");
  if (((claimed ?? []) as unknown[]).length === 0) {
    if (change.status === "applied") return { ok: true, message: `Already done - ${change.item_label} is ${next}.` };
    return { ok: false, message: `#${approval.short_code ?? "?"} was already handled - nothing changed.` };
  }
  const finish = async (status: PriceChangeRow["status"], result: string, extra: Record<string, unknown> = {}) => {
    await db.from("price_changes").update({ status, result, ...extra }).eq("id", change.id).eq("status", "applying");
  };

  // Never a cut, never more than +15% (re-checked: the row is the source of truth).
  const cap = Math.floor(change.old_rate_cents * (1 + MAX_RAISE));
  if (!(change.new_rate_cents > change.old_rate_cents) || change.new_rate_cents > cap || !change.service_catalog_item_id) {
    await finish("failed", "outside the +15% cap");
    return { ok: false, message: `Nothing changed - that price change is outside what I'm allowed to do (raise up to 15%).` };
  }

  try {
    const update: Record<string, unknown> = { rate_cents: change.new_rate_cents, active: true };
    if (change.new_minimum_cents !== change.old_minimum_cents) update.minimum_cents = change.new_minimum_cents;
    const { data: written, error } = await db
      .from("service_catalog_items")
      .update(update)
      .eq("organization_id", approval.organization_id)
      .eq("company_id", approval.company_id)
      .eq("id", change.service_catalog_item_id)
      .eq("rate_cents", change.old_rate_cents)
      .select("id");
    if (error) throw error;
    if (((written ?? []) as unknown[]).length === 0) {
      const { data: now } = await db.from("service_catalog_items").select("rate_cents").eq("organization_id", approval.organization_id).eq("company_id", approval.company_id).eq("id", change.service_catalog_item_id).maybeSingle();
      await finish("stale", now ? "price changed since the question" : "item removed");
      return now
        ? { ok: false, message: `Nothing changed - ${change.item_label} is ${priceText(Number((now as { rate_cents: number }).rate_cents), asProposal(change))} now, not ${old} (it was changed since I asked).` }
        : { ok: false, message: `Nothing changed - ${change.item_label} isn't on your price list any more.` };
    }
  } catch (err) {
    console.error("[profit-advisor] price change failed:", err instanceof Error ? err.message : err);
    await finish("failed", "couldn't write the price");
    return { ok: false, message: `Couldn't change the ${change.item_label} price - nothing changed. You can change it in your price list.` };
  }
  await finish("applied", "raised", { applied_at: at });
  return { ok: true, message: `Done - ${change.item_label} is now ${next} on your price list (was ${old}). New quotes use it; quotes already sent keep their price. I'll show you how it does in next month's price check.` };
}
