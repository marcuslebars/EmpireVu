/**
 * Profit advisor (docs/ai-staff.md → "Profit advisor"): margins, pricing, cash forecast.
 *
 *   Weekly   Friday 15:00 local (setting): one money text — jobs done, billed, profit and margin,
 *            the best job and the one to watch, the next 30 days' cash — only when 2+ jobs were
 *            finished that week or cash looks tight.
 *   Pricing  first Tuesday of the month: margin and quote win rate per price-list item; an item
 *            well under the company's margin that customers still say yes to gets a `price_change`
 *            question (capped +15%, never a cut, once per item per 90 days, recorded so the next
 *            check shows the effect). Nothing changes without the owner's Y.
 *   Cash     a 30/60/90-day forecast (pure maths in forecast.ts; tolerant reads of the other roles'
 *            tables in forecast-data.ts) with likely and cautious cases and "tight" detection;
 *            a briefing line for the Office manager when the next 30 days look tight.
 *   Tools    profit, job_profit, cash_forecast, pricing_check (all read-only).
 *
 * Sweeps: profit_advisor:weekly, profit_advisor:pricing. Off for house orgs unless switched on.
 * No model calls: every number and every text is built in code.
 */
import type { AdminClient } from "@/server/services/front-desk/contracts";
import { emptyRole, type StaffRoleModule, type StaffSweep } from "@/server/services/staff/types";
import { executePriceChange, PRICE_CHANGE_KIND } from "./price-change";
import { profitAdvisorOwnerTools } from "./owner-tools";
import { loadProfitCompanies, profitAdvisorActiveFor, type ProfitCompany } from "./settings";
import { runCompanyPricing, runCompanyWeekly } from "./sweeps";

let cached: { atMs: number; companies: ProfitCompany[] } | null = null;

/** The feature-on companies, loaded at most once per 30 s and shared by the sweeps. */
async function companiesFor(admin: AdminClient, nowMs: number): Promise<ProfitCompany[]> {
  if (cached && Math.abs(nowMs - cached.atMs) < 30_000) return cached.companies;
  const companies = await loadProfitCompanies(admin);
  cached = { atMs: nowMs, companies };
  return companies;
}

/** Test hook. */
export function resetProfitAdvisorCompanyCache(): void {
  cached = null;
}

async function eachCompany(admin: AdminClient, nowMs: number, run: (company: ProfitCompany) => Promise<unknown>): Promise<void> {
  for (const company of await companiesFor(admin, nowMs)) {
    try {
      await run(company);
    } catch (err) {
      console.error("[profit-advisor] company pass failed", company.companyId, err instanceof Error ? err.message : err);
    }
  }
}

export const PROFIT_ADVISOR_SWEEPS: StaffSweep[] = [
  { name: "profit_advisor:weekly", intervalMs: 10 * 60_000, run: (admin, nowMs) => eachCompany(admin, nowMs, (c) => runCompanyWeekly(admin, c, nowMs)) },
  { name: "profit_advisor:pricing", intervalMs: 30 * 60_000, run: (admin, nowMs) => eachCompany(admin, nowMs, (c) => runCompanyPricing(admin, c, nowMs)) },
];

export const profitAdvisorRole: StaffRoleModule = {
  ...emptyRole("profit_advisor"),
  activeFor: profitAdvisorActiveFor,
  approvalExecutors: {
    [PRICE_CHANGE_KIND]: (admin, approval, decision) => executePriceChange(admin, approval, decision),
  },
  ownerTools: profitAdvisorOwnerTools(),
  ownerPromptNotes: [
    "Profit advisor: use profit for \"profit\", \"how did we do this week/month\", \"what made money\" (period this_week by default; the Friday money text says \"Text 'profit' for more\" - answer with this week's numbers), job_profit for one job (\"how did the Jones roof do\"), cash_forecast for cash, \"will I be OK\", \"can I afford\", and pricing_check for \"am I charging enough\" / \"should I raise prices\". Keep the answer short: the key numbers, best/worst, and anything that makes it a guess (crew with no pay rate, jobs with no price). Say figures are estimates from their app data, not financial advice. Prices only change when the owner answers Y to a price_change question (#code) - you can't change a price yourself; pricing_check never does. The forecast starts at $0 today (no bank balance) and only says whether more goes out than comes in.",
  ],
  sweeps: PROFIT_ADVISOR_SWEEPS,
};
