/**
 * The Profit advisor's owner-by-text tools (scoped to the ONE company the owner's phone resolved
 * to — state.scope; names from the model are only matched inside it). All READ-ONLY: prices only
 * change through a price_change question the owner answers Y.
 *
 *   profit         this week / last week / this month / last month / last 30 days: jobs, billed,
 *                  profit, margin, best and worst jobs (and why), what makes it a guess
 *   job_profit     "how did the Jones roof do": one finished job's money in and out
 *   cash_forecast  the next 30/60/90 days, likely and cautious, and when it looks tight
 *   pricing_check  margin and win rate per price-list item, what the monthly check would ask,
 *                  and how past price changes did
 *
 * Never throw (return { error }).
 */
import type { ToolRunState } from "@/server/services/owner-channel/tools";
import type { RoleOwnerTool } from "@/server/services/staff/types";
import { categoryLabel } from "@/server/services/expenses/rules";
import { jobProfit } from "@/server/services/time/service";
import type { Db } from "./db-types";
import { forecastFor } from "./forecast-data";
import { addDays, clip, DISCLAIMER, dollars, hours, jobName, localDay, localMidnightIso, mondayOf, pct, shortDate, shortMoney, wholeDollars } from "./format";
import { loadJobProfits, serviceCtx } from "./jobs";
import { priceText } from "./pricing";
import { effectLine, runPricingCheck } from "./pricing-check";
import { loadProfitCompany, type ProfitCompany } from "./settings";
import { summarizeJobs, watchReason } from "./summary";
import { caveats, forecastLine } from "./texts";

const OFF = "The profit advisor is off for this business (Settings > AI front desk > Profit advisor).";
type Input = Record<string, unknown>;

function str(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

async function companyFor(state: ToolRunState): Promise<ProfitCompany | { error: string }> {
  const company = await loadProfitCompany(state.admin, state.scope.organizationId, state.scope.companyId);
  if (!company) return { error: "Business not found." };
  if (!company.settings.enabled) return { error: OFF };
  return company;
}

function guard(run: (state: ToolRunState, input: Input) => Promise<Record<string, unknown>>) {
  return async (state: ToolRunState, input: Input) => {
    try {
      return await run(state, input);
    } catch (err) {
      console.error("[profit-advisor] owner tool failed:", err instanceof Error ? err.message : err);
      return { error: "Something went wrong - try again in a minute." };
    }
  };
}

export type ProfitPeriod = "this_week" | "last_week" | "this_month" | "last_month" | "last_30_days";
const PERIODS: ProfitPeriod[] = ["this_week", "last_week", "this_month", "last_month", "last_30_days"];

/** The local window for a period name. PURE. */
export function periodWindow(period: ProfitPeriod, today: string, timeZone: string, nowMs: number): { fromIso: string; toIso: string; label: string } {
  const now = new Date(nowMs).toISOString();
  const month = `${today.slice(0, 8)}01`;
  switch (period) {
    case "last_week": {
      const mon = addDays(mondayOf(today), -7);
      return { fromIso: localMidnightIso(mon, timeZone), toIso: localMidnightIso(mondayOf(today), timeZone), label: `last week (${shortDate(mon)} - ${shortDate(addDays(mon, 6))})` };
    }
    case "this_month":
      return { fromIso: localMidnightIso(month, timeZone), toIso: now, label: "this month so far" };
    case "last_month": {
      const prev = `${addDays(month, -1).slice(0, 8)}01`;
      return { fromIso: localMidnightIso(prev, timeZone), toIso: localMidnightIso(month, timeZone), label: `last month (${shortDate(prev).split(" ")[0]})` };
    }
    case "last_30_days":
      return { fromIso: localMidnightIso(addDays(today, -29), timeZone), toIso: now, label: "the last 30 days" };
    default:
      return { fromIso: localMidnightIso(mondayOf(today), timeZone), toIso: now, label: "this week so far" };
  }
}

async function profitTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const period = PERIODS.includes(input.period as ProfitPeriod) ? (input.period as ProfitPeriod) : "this_week";
  const today = localDay(state.nowMs, company.timeZone);
  const w = periodWindow(period, today, company.timeZone, state.nowMs);
  const jobs = await loadJobProfits(state.admin, company, w.fromIso, w.toIso, state.nowMs);
  const s = summarizeJobs(jobs.rows, jobs.missingRateNames);
  const byId = new Map(jobs.rows.map((r) => [r.bookingId, r]));
  const money = (l: { name: string; profitCents: number; margin: number | null; bookingId: string }) => {
    const r = byId.get(l.bookingId);
    return {
      job: l.name,
      profit: wholeDollars(l.profitCents),
      margin: l.margin != null ? pct(l.margin) : null,
      why: r && (l.profitCents < 0 || (l.margin ?? 1) < 0.15) ? watchReason(r) : null,
    };
  };
  return {
    ok: true,
    period: w.label,
    jobs_done: s.jobs,
    billed: wholeDollars(s.billedCents),
    costs: wholeDollars(s.costCents),
    profit: wholeDollars(s.profitCents),
    margin: s.margin != null ? pct(s.margin) : null,
    best: s.top.map(money),
    worst: s.bottom.filter((b) => !s.top.slice(0, 1).some((t) => t.bookingId === b.bookingId)).map(money),
    crew_without_pay_rate: s.missingRateNames.map((n) => clip(n, 40)),
    caveats: caveats(s),
    partial: jobs.truncated || undefined,
    how: "Profit = what was billed (invoice, else the approved quote) minus crew hours x pay rates, materials logged on the job and receipts on the job (before tax).",
    disclaimer: DISCLAIMER,
  };
}

async function jobProfitTool(state: ToolRunState, input: Input): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const ref = str(input.job, 120);
  if (!ref) return { error: "Which job? Pass the customer's name and/or job words as `job`." };
  const db = state.admin as Db;
  const since = new Date(state.nowMs - 180 * 86_400_000).toISOString();
  const { data, error } = await db
    .from("bookings")
    .select("id, title, scheduled_for, status, contact_id, duration_minutes")
    .eq("organization_id", company.organizationId)
    .eq("company_id", company.companyId)
    .in("status", ["completed", "confirmed", "pending"])
    .gte("scheduled_for", since)
    .lte("scheduled_for", new Date(state.nowMs).toISOString())
    .order("scheduled_for", { ascending: false })
    .limit(500);
  if (error) throw error;
  const bookings = (data ?? []) as Array<{ id: string; title: string | null; scheduled_for: string; status: string; contact_id: string | null; duration_minutes: number | null }>;
  const contactIds = [...new Set(bookings.map((b) => b.contact_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data: contacts } = await db.from("contacts").select("id, first_name, last_name").eq("organization_id", company.organizationId).in("id", contactIds.slice(i, i + 200));
    for (const c of (contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) names.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(" "));
  }
  const words = ref.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length >= 2 && !["the", "job", "how", "did", "do", "for", "on", "at", "of"].includes(w));
  if (words.length === 0) return { error: "Which job? Give me the customer's name or a word from the job." };
  const scored = bookings
    .map((b) => {
      const hay = `${names.get(b.contact_id ?? "") ?? ""} ${b.title ?? ""}`.toLowerCase();
      return { b, hits: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.hits > 0);
  if (scored.length === 0) return { error: `No job in the last 6 months matches "${clip(ref, 60)}".` };
  const top = Math.max(...scored.map((x) => x.hits));
  const best = scored.filter((x) => x.hits === top);
  const done = best.filter((x) => x.b.status === "completed");
  const pick = done.length ? done : best;
  if (pick.length > 1 && !(input.most_recent === true)) {
    return {
      ok: true,
      which_one: pick.slice(0, 5).map((x) => ({ job: jobName({ contactName: names.get(x.b.contact_id ?? "") ?? null, title: x.b.title }), day: shortDate(localDay(Date.parse(x.b.scheduled_for), company.timeZone)), status: x.b.status })),
      tell_owner: "Several jobs match - ask which one (or call again with most_recent: true for the latest).",
    };
  }
  const b = pick[0].b;
  const p = await jobProfit(serviceCtx(state.admin, company.organizationId), b.id, new Date(state.nowMs));
  const { data: assigned } = await db.from("booking_assignments").select("profile_id").eq("organization_id", company.organizationId).eq("booking_id", b.id);
  const crewCount = new Set(((assigned ?? []) as Array<{ profile_id: string }>).map((a) => a.profile_id)).size;
  const booked = (b.duration_minutes ?? 0) * Math.max(1, crewCount);
  return {
    ok: true,
    job: jobName({ contactName: names.get(b.contact_id ?? "") ?? null, title: b.title }),
    day: shortDate(localDay(Date.parse(b.scheduled_for), company.timeZone)),
    status: b.status,
    billed: dollars(p.revenueCents),
    billed_from: p.revenueSource === "invoice" ? "the invoice" : p.revenueSource === "estimate" ? "the approved quote / series price (not invoiced yet)" : "nothing yet - no price on this job",
    labour: `${hours(p.labourMinutes)} (${dollars(p.labourCents)})${booked > 0 ? `, booked ${hours(booked)}` : ""}`,
    materials: dollars(p.materialsCents),
    receipts: dollars(p.expensesCents),
    profit: dollars(p.profitCents),
    margin: p.marginPct != null ? `${Math.round(p.marginPct)}%` : null,
    why: p.profitCents < 0 || (p.marginPct ?? 100) < 15 ? watchReason({ ...p, durationMinutes: b.duration_minutes ?? 0, crewCount }) : null,
    crew_without_pay_rate: p.missingRateNames.map((n) => clip(n, 40)),
    still_clocked_in: p.running || undefined,
    disclaimer: DISCLAIMER,
  };
}

async function cashTool(state: ToolRunState): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const f = await forecastFor(state.admin, company, state.nowMs);
  if (!f) return { error: "Couldn't work out the forecast right now - try again in a minute." };
  const year = Number(f.today.slice(0, 4));
  const in30 = f.moneyIn.filter((i) => i.date < addDays(f.today, 30)).sort((a, b) => b.likelyCents - a.likelyCents);
  return {
    ok: true,
    summary: forecastLine(f, year),
    windows: f.windows.map((w) => ({
      next_days: w.days,
      money_in: `about ${shortMoney(w.inLikelyCents)} (cautious ${shortMoney(w.inLowCents)})`,
      money_out: `about ${shortMoney(w.outLikelyCents)} (cautious ${shortMoney(w.outLowCents)})`,
      net: `${shortMoney(w.netLikelyCents)} (cautious ${shortMoney(w.netLowCents)})`,
    })),
    tight_next_30_days: f.tight30.tight ? `around ${shortDate(f.tight30.date!, year)}, about ${wholeDollars(f.tight30.shortCents)} short` : "no",
    tight_next_90_days: f.tight90.tight ? `around ${shortDate(f.tight90.date!, year)}, about ${wholeDollars(f.tight90.shortCents)} short` : "no",
    tight_if_things_go_slow: f.lowCase.tight ? `around ${shortDate(f.lowCase.date!, year)}, about ${wholeDollars(f.lowCase.shortCents)} short` : "no",
    biggest_coming_in_30_days: in30.slice(0, 5).map((i) => `${clip(i.label, 40)} ${shortMoney(i.likelyCents)} around ${shortDate(i.date, year)}`),
    going_out: [
      `overhead about ${shortMoney(f.overhead.dailyCents * 30)}/month (${f.overhead.byCategory.slice(0, 3).map((c) => `${categoryLabel(c.category)} ${shortMoney(c.monthlyCents)}`).join(", ") || "no expenses logged"})`,
      `payroll about ${shortMoney(f.payroll.dailyCents * 30)}/month`,
      ...f.moneyOut.slice(0, 5).map((o) => `${clip(o.label, 40)} ${shortMoney(o.lowCents)} around ${shortDate(o.date, year)}`),
    ],
    cushion: f.cushionCents > 0 ? `tight = more than ${wholeDollars(f.cushionCents)} more out than in` : "tight = more going out than coming in",
    notes: f.notes,
    how: "Starts at $0 today (I can't see your bank balance): what's due in from invoices, quotes and booked jobs, minus your usual spending, payroll, HST and open orders.",
    disclaimer: DISCLAIMER,
  };
}

async function pricingTool(state: ToolRunState): Promise<Record<string, unknown>> {
  const company = await companyFor(state);
  if ("error" in company) return company;
  const report = await runPricingCheck(state.admin, company, state.nowMs);
  const rows = report.items.filter((i) => i.jobs > 0 || i.quotes > 0).slice(0, 12);
  return {
    ok: true,
    read_only: "Nothing was changed. Price changes only happen when the owner says Y to a price change question (asked after the monthly check, first Tuesday).",
    window: "last 6 months",
    your_average_margin: report.companyMargin != null ? pct(report.companyMargin) : null,
    jobs_counted: report.pricedJobs,
    items: rows.map((i) => ({
      item: clip(i.label, 50),
      price: i.rateCents > 0 ? priceText(i.rateCents, i) : "no price",
      jobs: i.jobs,
      margin: i.margin != null ? pct(i.margin) : null,
      quotes_decided: i.quotes,
      win_rate: i.winRate != null ? pct(i.winRate) : null,
      looks_underpriced: i.underpriced || undefined,
      would_ask: i.proposal ? `raise to ${priceText(i.proposal.newRateCents, i.proposal)} (+${i.proposal.pct}%)` : undefined,
      not_asked_because:
        i.held === "recent_change" ? "changed or turned down in the last 90 days" : i.held === "pending" ? "a question is already waiting" : i.held === "not_simple" ? "tiered/banded price - change it by hand" : i.held === "no_room" ? "raise would be too small" : undefined,
    })),
    waiting_on_you: report.pending.map((p) => `${clip(p.label, 40)} ${dollars(p.oldRateCents)} to ${dollars(p.newRateCents)}`),
    past_changes: report.changes.map((c) => effectLine(c, state.nowMs)),
    rule: "Flagged when it has 5+ jobs and 5+ decided quotes, its margin is 10+ points under your average, and you win 70%+ of its quotes. Raises are capped at 15%, never cuts, at most once per item per 90 days.",
    partial: report.truncated || undefined,
    disclaimer: DISCLAIMER,
  };
}

export function profitAdvisorOwnerTools(): RoleOwnerTool[] {
  return [
    {
      tool: {
        name: "profit",
        description:
          "How the money went on finished jobs: jobs done, billed, profit and margin, the best and worst jobs (and why), and what's missing (crew without a pay rate, jobs with no price). period: this_week (default), last_week, this_month, last_month, last_30_days. Use for 'profit', 'how did we do this week', 'what made money'.",
        input_schema: { type: "object", properties: { period: { type: "string", enum: PERIODS } } },
      },
      run: guard(profitTool),
    },
    {
      tool: {
        name: "job_profit",
        description: "One job's money: billed, labour hours and cost (vs booked), materials, receipts, profit and margin. `job` = customer name and/or job words ('Jones roof'). Several matches → it lists them; most_recent: true picks the latest.",
        input_schema: { type: "object", properties: { job: { type: "string" }, most_recent: { type: "boolean" } }, required: ["job"] },
      },
      run: guard(jobProfitTool),
    },
    {
      tool: {
        name: "cash_forecast",
        description: "The next 30/60/90 days of money in and out (likely and cautious), when cash looks tight and by how much, the biggest amounts coming in and going out. Use for 'cash', 'will I be OK this month', 'can I afford…', 'forecast'.",
        input_schema: { type: "object", properties: {} },
      },
      run: guard((state) => cashTool(state)),
    },
    {
      tool: {
        name: "pricing_check",
        description: "Read-only: margin and quote win rate per price-list item over 6 months, which look underpriced and what raise the monthly check would ask about, and how past price changes did. Never changes a price.",
        input_schema: { type: "object", properties: {} },
      },
      run: guard((state) => pricingTool(state)),
    },
  ];
}
