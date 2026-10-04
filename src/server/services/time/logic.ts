/**
 * Timesheet + job-costing maths (pure). Minutes are whole minutes; money is cents.
 */

export interface EntryTimes {
  started_at: string;
  ended_at: string | null;
  break_minutes: number;
}

/** Worked minutes for an entry; a running entry counts up to `now`. Never negative. */
export function workedMinutes(e: EntryTimes, now: Date = new Date()): number {
  const end = e.ended_at ? Date.parse(e.ended_at) : now.getTime();
  const gross = Math.floor((end - Date.parse(e.started_at)) / 60_000);
  return Math.max(0, gross - (e.break_minutes || 0));
}

/** Labour cost of `minutes` at an hourly rate, rounded to the cent. */
export function labourCents(minutes: number, hourlyCents: number): number {
  return Math.round((minutes * hourlyCents) / 60);
}

export function materialCents(m: { quantity: number; unit_cost_cents: number }): number {
  return Math.round(Number(m.quantity) * m.unit_cost_cents);
}

/** "7h 05m" */
export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export interface CostEntry extends EntryTimes {
  profile_id: string;
}

export interface JobProfit {
  revenueCents: number;
  /** Where revenue came from: the invoice, the approved quote / series price, or nothing yet. */
  revenueSource: "invoice" | "estimate" | "none";
  labourMinutes: number;
  labourCents: number;
  materialsCents: number;
  costCents: number;
  profitCents: number;
  /** Profit ÷ revenue, or null with no revenue. */
  marginPct: number | null;
  /** People who logged time but have no pay rate (their time counts as $0). */
  missingRates: string[];
  running: boolean;
}

export function computeJobProfit(input: {
  revenueCents: number;
  revenueSource: JobProfit["revenueSource"];
  entries: CostEntry[];
  rates: Map<string, number>;
  materials: Array<{ quantity: number; unit_cost_cents: number }>;
  now?: Date;
}): JobProfit {
  const now = input.now ?? new Date();
  let labourMinutes = 0;
  let labour = 0;
  const missing = new Set<string>();
  for (const e of input.entries) {
    const mins = workedMinutes(e, now);
    labourMinutes += mins;
    const rate = input.rates.get(e.profile_id);
    if (rate === undefined) missing.add(e.profile_id);
    else labour += labourCents(mins, rate);
  }
  const materials = input.materials.reduce((s, m) => s + materialCents(m), 0);
  const cost = labour + materials;
  const profit = input.revenueCents - cost;
  return {
    revenueCents: input.revenueCents,
    revenueSource: input.revenueSource,
    labourMinutes,
    labourCents: labour,
    materialsCents: materials,
    costCents: cost,
    profitCents: profit,
    marginPct: input.revenueCents > 0 ? Math.round((profit / input.revenueCents) * 1000) / 10 : null,
    missingRates: [...missing],
    running: input.entries.some((e) => !e.ended_at),
  };
}

/** Monday 00:00 of the week containing `ymd` (YYYY-MM-DD), as YYYY-MM-DD. */
export function weekStart(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay(); // 0 = Sun
  const back = (dow + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

/** Minutes per local day for a set of entries (entries are attributed to the day they start). */
export function minutesByDay(entries: EntryTimes[], timeZone: string, now: Date = new Date()): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    const day = new Date(e.started_at).toLocaleDateString("en-CA", { timeZone });
    out.set(day, (out.get(day) ?? 0) + workedMinutes(e, now));
  }
  return out;
}

/** CSV-safe cell (quotes, commas, newlines; neutralises spreadsheet formulas). */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
