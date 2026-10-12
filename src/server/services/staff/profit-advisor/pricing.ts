/**
 * The pricing check's maths (docs/ai-staff.md → "Profit advisor"). PURE (fixture-tested).
 *
 * Margin per price-list item. A job's revenue and profit come from job costing (jobs.ts). A job
 * booked from a quote is split across the quote's lines the customer took, IN PROPORTION TO EACH
 * LINE'S AMOUNT (a $900 roof line and a $100 vent line on one job → 90% / 10% of that job's revenue
 * and profit). Hand-priced (custom) lines take their share too but belong to no item. A job with
 * no quote counts wholly for its booking's price-list item (bookings.service_item_id), if any.
 * An item's margin = its share of profit ÷ its share of revenue; "jobs" counts every job it was
 * on. The company average is all priced jobs' profit ÷ revenue.
 *
 * Win rate per item: of the quotes sent in the window that had the item (and aren't replaced by a
 * revision), those approved ÷ those decided. A quote still open (sent in the last 30 days and not
 * approved, expired or cancelled) isn't decided yet, so it's left out.
 *
 * Flag: ≥ 5 finished jobs AND ≥ 5 decided quotes, margin at least 10 points under the company
 * average, AND a win rate of 70%+ (customers say yes easily → the price has room).
 *
 * Proposal: the raise that would bring the item to the company average at the same cost
 * ((1 − item margin) ÷ (1 − average margin)), capped at +15%, rounded DOWN to a tidy price
 * ($5 steps from $100, $1 from $20, 25¢ from $5), never below +3% (not worth asking) and never a
 * cut. Only simple per-item prices (flat / per unit / per measure) are proposed; tiered and banded
 * prices aren't touched. At most one change per item per 90 days (a "no" counts).
 */
import { dollars, pct } from "./format";

export const PRICING_WINDOW_DAYS = 180;
export const MIN_JOBS = 5;
export const MIN_QUOTES = 5;
export const MIN_WIN_RATE = 0.7;
export const MARGIN_GAP = 0.1;
export const MAX_RAISE = 0.15;
export const MIN_RAISE = 0.03;
export const COOL_DAYS = 90;
export const OPEN_QUOTE_DAYS = 30;
/** price_change questions per company per monthly check (most underpriced first). */
export const MAX_ASKS_PER_RUN = 2;
export const SIMPLE_PRICING_TYPES: ReadonlySet<string> = new Set(["flat", "per_unit", "per_measure", "per_unit_declining"]);

export interface PricingLine {
  /** Catalog item id, or null for a hand-priced / unknown line. */
  itemId: string | null;
  amountCents: number;
}

export interface JobForPricing {
  bookingId: string;
  revenueCents: number;
  profitCents: number;
  lines: PricingLine[];
}

export interface QuoteForPricing {
  id: string;
  won: boolean;
  itemIds: string[];
}

export interface CatalogForPricing {
  id: string;
  label: string;
  pricingType: string;
  rateCents: number;
  minimumCents: number;
  unitLabel: string | null;
  active: boolean;
}

export interface ItemStats {
  itemId: string;
  jobs: number;
  revenueCents: number;
  profitCents: number;
  margin: number | null;
  quotes: number;
  won: number;
  winRate: number | null;
}

/** Each job's revenue/profit split over its items by line amount. PURE. */
export function attributeJobs(jobs: JobForPricing[]): Map<string, { jobs: number; revenueCents: number; profitCents: number }> {
  const out = new Map<string, { jobs: number; revenueCents: number; profitCents: number }>();
  for (const job of jobs) {
    if (!(job.revenueCents > 0)) continue;
    const lines = job.lines.filter((l) => l.amountCents > 0 || job.lines.every((x) => !(x.amountCents > 0)));
    if (lines.length === 0) continue;
    const total = lines.reduce((s, l) => s + Math.max(0, l.amountCents), 0);
    const shares = new Map<string, number>();
    for (const l of lines) {
      if (!l.itemId) continue;
      const share = total > 0 ? Math.max(0, l.amountCents) / total : 1 / lines.length;
      shares.set(l.itemId, (shares.get(l.itemId) ?? 0) + share);
    }
    for (const [itemId, share] of shares) {
      const s = out.get(itemId) ?? { jobs: 0, revenueCents: 0, profitCents: 0 };
      s.jobs += 1;
      s.revenueCents += job.revenueCents * share;
      s.profitCents += job.profitCents * share;
      out.set(itemId, s);
    }
  }
  return out;
}

/** Per-item margin + win rate, and the company average margin. PURE. */
export function itemStats(jobs: JobForPricing[], quotes: QuoteForPricing[]): { companyMargin: number | null; items: Map<string, ItemStats> } {
  const priced = jobs.filter((j) => j.revenueCents > 0);
  const revenue = priced.reduce((s, j) => s + j.revenueCents, 0);
  const profit = priced.reduce((s, j) => s + j.profitCents, 0);
  const attributed = attributeJobs(priced);
  const items = new Map<string, ItemStats>();
  const get = (itemId: string) => {
    let s = items.get(itemId);
    if (!s) {
      s = { itemId, jobs: 0, revenueCents: 0, profitCents: 0, margin: null, quotes: 0, won: 0, winRate: null };
      items.set(itemId, s);
    }
    return s;
  };
  for (const [itemId, a] of attributed) {
    const s = get(itemId);
    s.jobs = a.jobs;
    s.revenueCents = Math.round(a.revenueCents);
    s.profitCents = Math.round(a.profitCents);
    s.margin = a.revenueCents > 0 ? a.profitCents / a.revenueCents : null;
  }
  for (const q of quotes) {
    for (const itemId of new Set(q.itemIds)) {
      const s = get(itemId);
      s.quotes += 1;
      if (q.won) s.won += 1;
    }
  }
  for (const s of items.values()) s.winRate = s.quotes > 0 ? s.won / s.quotes : null;
  return { companyMargin: revenue > 0 ? profit / revenue : null, items };
}

/** Underpriced: plenty of jobs and quotes, margin well under average, and customers say yes. PURE. */
export function isUnderpriced(s: ItemStats, companyMargin: number | null): boolean {
  if (companyMargin == null || s.margin == null || s.winRate == null) return false;
  return s.jobs >= MIN_JOBS && s.quotes >= MIN_QUOTES && s.winRate >= MIN_WIN_RATE && s.margin <= companyMargin - MARGIN_GAP;
}

/** A tidy price ≤ cap, above `old`. Null when there's no room. PURE. */
export function tidyPrice(targetCents: number, oldCents: number, capCents: number): number | null {
  const step = oldCents >= 10_000 ? 500 : oldCents >= 2_000 ? 100 : oldCents >= 500 ? 25 : 1;
  const down = Math.floor(Math.min(targetCents, capCents) / step) * step;
  if (down > oldCents) return down;
  const exact = Math.floor(Math.min(targetCents, capCents));
  return exact > oldCents ? exact : null;
}

export interface Proposal {
  itemId: string;
  label: string;
  unitLabel: string | null;
  pricingType: string;
  oldRateCents: number;
  newRateCents: number;
  oldMinimumCents: number;
  newMinimumCents: number;
  /** Whole percent, e.g. 11. */
  pct: number;
}

/** The raise for an underpriced item (capped +15%, tidy, never a cut), or null. PURE. */
export function proposeRaise(item: CatalogForPricing, s: ItemStats, companyMargin: number): Proposal | null {
  if (!SIMPLE_PRICING_TYPES.has(item.pricingType) || !(item.rateCents > 0) || s.margin == null || companyMargin >= 1) return null;
  const needed = (1 - s.margin) / (1 - companyMargin) - 1;
  const raise = Math.min(MAX_RAISE, needed);
  if (!(raise >= MIN_RAISE)) return null;
  const cap = Math.floor(item.rateCents * (1 + MAX_RAISE));
  const next = tidyPrice(item.rateCents * (1 + raise), item.rateCents, cap);
  if (next == null || next <= item.rateCents || next > cap) return null;
  const pctUp = Math.round(((next - item.rateCents) / item.rateCents) * 100);
  if (pctUp < Math.round(MIN_RAISE * 100)) return null;
  const minimum = item.minimumCents > 0 ? Math.min(Math.floor(item.minimumCents * (1 + MAX_RAISE)), Math.max(item.minimumCents, Math.floor((item.minimumCents * next) / item.rateCents / 100) * 100)) : item.minimumCents;
  return { itemId: item.id, label: item.label, unitLabel: item.unitLabel, pricingType: item.pricingType, oldRateCents: item.rateCents, newRateCents: next, oldMinimumCents: item.minimumCents, newMinimumCents: minimum, pct: pctUp };
}

/** "$189" / "$4.50 a sq ft". */
export function priceText(cents: number, p: Pick<Proposal, "pricingType" | "unitLabel">): string {
  return p.pricingType === "flat" || !p.unitLabel?.trim() ? dollars(cents) : `${dollars(cents)} a ${p.unitLabel.trim()}`;
}

/** The owner's price_change text (without the "Reply Y …" line). PURE. */
export function priceChangeSummary(p: Proposal, s: Pick<ItemStats, "jobs" | "margin" | "winRate">, companyMargin: number): string {
  const min = p.newMinimumCents !== p.oldMinimumCents ? ` (minimum ${dollars(p.oldMinimumCents)} to ${dollars(p.newMinimumCents)})` : "";
  return (
    `Price check - ${p.label}: ${s.jobs} jobs in 6 months, ${pct(s.margin ?? 0)} margin (you average ${pct(companyMargin)}), and you win ${pct(s.winRate ?? 0)} of quotes. ` +
    `Y raises it from ${priceText(p.oldRateCents, p)} to ${priceText(p.newRateCents, p)} (+${p.pct}%)${min} for new quotes. Estimates from your app data - not financial advice.`
  );
}
