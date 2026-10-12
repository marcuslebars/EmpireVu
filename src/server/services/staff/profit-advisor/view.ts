/**
 * Settings → AI front desk → Profit advisor (docs/ai-staff.md → "Profit advisor"): the switches for
 * everyone; the money (the cash forecast, the pricing check, the last weekly text) only for
 * owners/admins — margins come from pay rates, which are owner/admin-only. Writes go through
 * updateAiSettings (only ai_settings.profit_advisor).
 */
import { updateAiSettings } from "@/server/services/front-desk/ai-settings-write";
import type { AdminClient } from "@/server/services/front-desk/contracts";
import type { Db, ProfitRunRow } from "./db-types";
import { forecastFor } from "./forecast-data";
import { DISCLAIMER } from "./format";
import { runPricingCheck, type PricingReport } from "./pricing-check";
import { loadProfitCompany, mergeProfitAdvisorSettings, type ProfitAdvisorPatch, type ProfitAdvisorSettings } from "./settings";
import { forecastLine } from "./texts";

type Scope = { organizationId: string; companyId: string };

export interface ForecastView {
  summary: string;
  windows: Array<{ days: number; inLikelyCents: number; inLowCents: number; outLikelyCents: number; outLowCents: number }>;
  tight30: { tight: boolean; date: string | null; shortCents: number };
  tight90: { tight: boolean; date: string | null; shortCents: number };
  notes: string[];
}

export interface PricingView {
  companyMarginPct: number | null;
  items: Array<{ label: string; rateCents: number; unitLabel: string | null; jobs: number; marginPct: number | null; quotes: number; winRatePct: number | null; underpriced: boolean; proposalCents: number | null; proposalPct: number | null; held: string | null }>;
  changes: PricingReport["changes"];
  pending: PricingReport["pending"];
}

export interface ProfitAdvisorView {
  companyId: string;
  companyName: string;
  settings: ProfitAdvisorSettings;
  ownerPhoneOnFile: boolean;
  manager: boolean;
  lastWeekly: { date: string; status: string; body: string | null } | null;
  forecast: ForecastView | null;
  pricing: PricingView | null;
  disclaimer: string;
}

export async function getProfitAdvisorView(admin: AdminClient, scope: Scope, opts: { manager: boolean; nowMs?: number }): Promise<ProfitAdvisorView | null> {
  const company = await loadProfitCompany(admin, scope.organizationId, scope.companyId);
  if (!company) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const base: ProfitAdvisorView = {
    companyId: company.companyId,
    companyName: company.name,
    settings: company.settings,
    ownerPhoneOnFile: Boolean(company.ownerPhone),
    manager: opts.manager,
    lastWeekly: null,
    forecast: null,
    pricing: null,
    disclaimer: DISCLAIMER,
  };
  if (!opts.manager || !company.settings.enabled) return base;
  const db = admin as Db;
  const { data: runs } = await db.from("profit_advisor_runs").select("*").eq("organization_id", company.organizationId).eq("company_id", company.companyId).eq("kind", "weekly").order("run_key", { ascending: false }).limit(1);
  const last = ((runs ?? []) as ProfitRunRow[])[0];
  if (last) base.lastWeekly = { date: last.run_key, status: last.status, body: last.body };
  const forecast = await forecastFor(admin, company, nowMs);
  if (forecast) {
    const year = Number(forecast.today.slice(0, 4));
    base.forecast = {
      summary: forecastLine(forecast, year),
      windows: forecast.windows.map((w) => ({ days: w.days, inLikelyCents: w.inLikelyCents, inLowCents: w.inLowCents, outLikelyCents: w.outLikelyCents, outLowCents: w.outLowCents })),
      tight30: { tight: forecast.tight30.tight, date: forecast.tight30.date, shortCents: forecast.tight30.shortCents },
      tight90: { tight: forecast.tight90.tight, date: forecast.tight90.date, shortCents: forecast.tight90.shortCents },
      notes: forecast.notes,
    };
  }
  try {
    const report = await runPricingCheck(admin, company, nowMs);
    base.pricing = {
      companyMarginPct: report.companyMargin != null ? Math.round(report.companyMargin * 100) : null,
      items: report.items
        .filter((i) => i.jobs > 0)
        .slice(0, 15)
        .map((i) => ({
          label: i.label,
          rateCents: i.rateCents,
          unitLabel: i.pricingType === "flat" ? null : i.unitLabel,
          jobs: i.jobs,
          marginPct: i.margin != null ? Math.round(i.margin * 100) : null,
          quotes: i.quotes,
          winRatePct: i.winRate != null ? Math.round(i.winRate * 100) : null,
          underpriced: i.underpriced,
          proposalCents: i.proposal?.newRateCents ?? null,
          proposalPct: i.proposal?.pct ?? null,
          held: i.held,
        })),
      changes: report.changes,
      pending: report.pending,
    };
  } catch (err) {
    console.error("[profit-advisor] settings pricing view failed:", err instanceof Error ? err.message : err);
  }
  return base;
}

export async function updateProfitAdvisorSettings(admin: AdminClient, scope: Scope, patch: ProfitAdvisorPatch): Promise<ProfitAdvisorView | null> {
  const saved = await updateAiSettings(admin, scope, (current) => mergeProfitAdvisorSettings(current, patch) as typeof current);
  if (!saved) return null;
  return getProfitAdvisorView(admin, scope, { manager: true });
}
