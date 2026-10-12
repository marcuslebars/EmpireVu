/**
 * A set of finished jobs → what the owner needs to hear: how many, billed, profit and margin, the
 * best one, the one to watch (and why), and what's missing that makes the numbers a guess.
 * PURE (fixture-tested).
 */
import { dollars, hours, jobName } from "./format";
import type { JobProfitRow } from "./jobs";

/** A job under this margin is one to watch (as is any job that lost money). */
export const WATCH_MARGIN = 0.15;
/** Labour this far over the booked time is the reason given. */
const LABOUR_OVER_MINUTES = 60;

export interface JobLine {
  bookingId: string;
  name: string;
  revenueCents: number;
  profitCents: number;
  margin: number | null;
  scheduledFor: string;
}

export interface JobsSummary {
  jobs: number;
  billedCents: number;
  costCents: number;
  profitCents: number;
  /** profit ÷ billed (priced jobs only), or null with nothing billed. */
  margin: number | null;
  best: JobLine | null;
  watch: (JobLine & { reason: string | null }) | null;
  /** Ranked lists for "profit" (top / bottom 3). */
  top: JobLine[];
  bottom: JobLine[];
  /** Jobs with no price (no invoice, quote or series price) — left out of billed / profit. */
  unpriced: number;
  /** Priced jobs with no cost at all logged (no hours, materials or receipts). */
  noCosts: number;
  missingRateNames: string[];
  /** Free callback / warranty visits (Customer care): how many, and what they cost. */
  careVisits: number;
  careCostCents: number;
  /** Visits already paid for by an annual service plan (not counted as jobs). */
  planVisits: number;
}

function line(r: JobProfitRow): JobLine {
  return { bookingId: r.bookingId, name: jobName({ contactName: r.contactName, title: r.title }), revenueCents: r.revenueCents, profitCents: r.profitCents, margin: r.revenueCents > 0 ? r.profitCents / r.revenueCents : null, scheduledFor: r.scheduledFor };
}

/** Why a job did badly, in a few words: "labour 9h over", "materials $640". PURE. */
export function watchReason(r: Pick<JobProfitRow, "labourMinutes" | "labourCents" | "materialsCents" | "expensesCents" | "durationMinutes" | "crewCount">): string | null {
  const booked = r.durationMinutes * Math.max(1, r.crewCount);
  if (booked > 0 && r.labourMinutes - booked >= LABOUR_OVER_MINUTES) return `labour ${hours(r.labourMinutes - booked)} over`;
  const stuff = r.materialsCents + r.expensesCents;
  if (stuff <= 0 && r.labourCents <= 0) return null;
  return stuff >= r.labourCents ? `materials ${dollars(Math.round(stuff / 100) * 100)}` : `labour ${dollars(Math.round(r.labourCents / 100) * 100)}`;
}

/**
 * Free visits (callbacks / warranty work, prepaid plan visits) aren't "jobs done" and never
 * "no price yet". A callback's cost is NOT charged back to the original job (that job is often
 * from an earlier week or month, so it would rewrite old numbers); it's reported on its own
 * ("1 free callback visit cost about $340"). Plan visits were paid for up front.
 */
export function summarizeJobs(all: JobProfitRow[], missingRateNames: string[] = []): JobsSummary {
  const careRows = all.filter((r) => r.freeVisit === "care");
  const rows = all.filter((r) => !r.freeVisit);
  const priced = rows.filter((r) => r.revenueCents > 0);
  const billed = priced.reduce((s, r) => s + r.revenueCents, 0);
  const cost = priced.reduce((s, r) => s + r.costCents, 0);
  const profit = billed - cost;
  const byProfit = [...priced].sort((a, b) => b.profitCents - a.profitCents || a.scheduledFor.localeCompare(b.scheduledFor));
  const bestRow = byProfit.find((r) => r.profitCents > 0) ?? null;
  const worst = [...byProfit].reverse().find((r) => r !== bestRow && (r.profitCents < 0 || r.profitCents / r.revenueCents < WATCH_MARGIN)) ?? null;
  return {
    jobs: rows.length,
    billedCents: billed,
    costCents: cost,
    profitCents: profit,
    margin: billed > 0 ? profit / billed : null,
    best: bestRow ? line(bestRow) : null,
    watch: worst ? { ...line(worst), reason: watchReason(worst) } : null,
    top: byProfit.slice(0, 3).map(line),
    bottom: [...byProfit].reverse().slice(0, 3).map(line),
    unpriced: rows.length - priced.length,
    noCosts: priced.filter((r) => r.costCents <= 0).length,
    missingRateNames,
    careVisits: careRows.length,
    careCostCents: careRows.reduce((sum, r) => sum + r.costCents, 0),
    planVisits: all.filter((r) => r.freeVisit === "plan").length,
  };
}
