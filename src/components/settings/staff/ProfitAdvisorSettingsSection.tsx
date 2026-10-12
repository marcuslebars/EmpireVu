import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, TrendingUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Profit advisor (docs/ai-staff.md → "Profit advisor"): the weekly money
 * text (on/off, day, time), the monthly price check (on/off), when cash counts as "tight", and —
 * for owners/admins — the cash forecast, margins and win rates per service, and past price
 * changes. Self-contained (own query + mutation). Nothing here changes a price.
 */

export interface ProfitAdvisorSettingsView {
  enabled: boolean;
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  weekly: { enabled: boolean; day: number; time: string };
  pricingCheck: { enabled: boolean };
  tightCushionCents: number;
}

export interface ProfitAdvisorView {
  companyId: string;
  companyName: string;
  settings: ProfitAdvisorSettingsView;
  ownerPhoneOnFile: boolean;
  manager: boolean;
  lastWeekly: { date: string; status: string; body: string | null } | null;
  forecast: {
    summary: string;
    windows: Array<{ days: number; inLikelyCents: number; inLowCents: number; outLikelyCents: number; outLowCents: number }>;
    tight30: { tight: boolean; date: string | null; shortCents: number };
    tight90: { tight: boolean; date: string | null; shortCents: number };
    notes: string[];
  } | null;
  pricing: {
    companyMarginPct: number | null;
    items: Array<{ label: string; rateCents: number; unitLabel: string | null; jobs: number; marginPct: number | null; quotes: number; winRatePct: number | null; underpriced: boolean; proposalCents: number | null; proposalPct: number | null; held: string | null }>;
    changes: Array<{ id: string; label: string; oldRateCents: number; newRateCents: number; appliedAt: string; before: { marginPct: number; winRatePct: number | null; jobs: number }; after: { jobs: number; marginPct: number | null; quotes: number; winRatePct: number | null } }>;
    pending: Array<{ label: string; oldRateCents: number; newRateCents: number }>;
  } | null;
  disclaimer: string;
}

type Patch = { enabled?: boolean; weekly?: { enabled?: boolean; day?: number; time?: string }; pricingCheck?: { enabled?: boolean }; tightCushionCents?: number };

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/profit-advisor`;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMES = Array.from({ length: 26 }, (_, i) => `${String(7 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const CUSHIONS = [0, 100_000, 250_000, 500_000, 1_000_000, 2_500_000];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${Math.abs(Math.round(cents / 100)).toLocaleString("en-CA")}`;
const price = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const day = (ymd: string | null) => {
  if (!ymd) return "";
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
const timeLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "a.m." : "p.m."}`;
};
const selectCls = "rounded-md border border-border bg-background px-2 py-1.5 text-sm";

export function ProfitAdvisorSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["profit-advisor-settings", orgId, companyId];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => apiFetch<ProfitAdvisorView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 60_000,
  });
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<ProfitAdvisorView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const s = data?.settings;
  return (
    <AiFrontDeskSectionCard
      icon={<TrendingUp className="w-4 h-4" />}
      title="Profit advisor"
      description="Watches your margins and cash: a short money text each week, a monthly check on your prices, and a heads-up when cash looks tight. It never changes a price without your Y."
      aside={
        s ? (
          <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
            <input type="checkbox" checked={s.enabled} disabled={!canManage || update.isPending} onChange={(e) => update.mutate({ enabled: e.target.checked })} className="accent-primary w-4 h-4" aria-label="Profit advisor on" />
            <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
          </label>
        ) : null
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data || !s ? (
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      ) : (
        <div className="space-y-4">
          <fieldset className={cn("space-y-3", !s.enabled && "opacity-60")} disabled={!canManage || !s.enabled || update.isPending}>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={s.weekly.enabled} onChange={(e) => update.mutate({ weekly: { enabled: e.target.checked } })} className="accent-primary mt-0.5 w-4 h-4" aria-label="Weekly money text" />
                <span>
                  <span className="block text-sm font-medium text-foreground">Weekly money text</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">Jobs done, billed, profit, the best job and the one to watch, and the next 30 days of cash. Only when you finished 2+ jobs that week or cash looks tight.</span>
                </span>
              </label>
              <div className={cn("flex flex-wrap gap-2 pl-6", !s.weekly.enabled && "opacity-60")}>
                <select aria-label="Weekly text day" value={s.weekly.day} disabled={!s.weekly.enabled} onChange={(e) => update.mutate({ weekly: { day: Number(e.target.value) } })} className={selectCls}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
                <select aria-label="Weekly text time" value={s.weekly.time} disabled={!s.weekly.enabled} onChange={(e) => update.mutate({ weekly: { time: e.target.value } })} className={selectCls}>
                  {TIMES.map((t) => (
                    <option key={t} value={t}>
                      {timeLabel(t)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={s.pricingCheck.enabled} onChange={(e) => update.mutate({ pricingCheck: { enabled: e.target.checked } })} className="accent-primary mt-0.5 w-4 h-4" aria-label="Monthly price check" />
              <span>
                <span className="block text-sm font-medium text-foreground">Monthly price check</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  First Tuesday of the month. When a service makes well under your average margin but you still win 70%+ of its quotes, I text you a raise to approve (Y/N). Capped at 15%, never a cut, at most once per service every 90 days.
                </span>
              </span>
            </label>

            <label className="block space-y-1">
              <span className="block text-sm font-medium text-foreground">Call cash "tight" when money out runs ahead of money in by more than</span>
              <select aria-label="Tight cushion" value={s.tightCushionCents} onChange={(e) => update.mutate({ tightCushionCents: Number(e.target.value) })} className={cn(selectCls, "w-full sm:w-auto")}>
                {(CUSHIONS.includes(s.tightCushionCents) ? CUSHIONS : [...CUSHIONS, s.tightCushionCents].sort((a, b) => a - b)).map((c) => (
                  <option key={c} value={c}>
                    {c === 0 ? "$0 (any shortfall)" : money(c)}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">I can't see your bank balance, so the forecast starts at $0 today. If you keep a cushion in the bank, set it here.</span>
            </label>
          </fieldset>

          {!data.ownerPhoneOnFile && s.enabled && <p className="text-xs text-amber-600">Add and confirm your cell (above) to get the weekly text and price questions.</p>}

          {data.forecast && (
            <div className="rounded-lg bg-secondary/50 p-3 space-y-2">
              <p className="text-xs font-medium text-foreground">Cash forecast</p>
              <p className={cn("text-sm", data.forecast.tight30.tight ? "text-amber-600 font-medium" : "text-foreground")}>{data.forecast.summary}</p>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal">Next</th>
                    <th className="text-right font-normal">Money in</th>
                    <th className="text-right font-normal">Money out</th>
                  </tr>
                </thead>
                <tbody>
                  {data.forecast.windows.map((w) => (
                    <tr key={w.days}>
                      <td>{w.days} days</td>
                      <td className="text-right">
                        {money(w.inLikelyCents)} <span className="text-muted-foreground">({money(w.inLowCents)} if slow)</span>
                      </td>
                      <td className="text-right">
                        {money(w.outLikelyCents)} <span className="text-muted-foreground">({money(w.outLowCents)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.forecast.tight30.tight && data.forecast.tight90.tight && (
                <p className="text-xs text-amber-600">
                  Looks tight later: around {day(data.forecast.tight90.date)} (about {money(data.forecast.tight90.shortCents)} short).
                </p>
              )}
              {data.forecast.notes.map((n) => (
                <p key={n} className="text-xs text-muted-foreground">
                  {n}
                </p>
              ))}
            </div>
          )}

          {data.pricing && data.pricing.items.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">
                Your services, last 6 months{data.pricing.companyMarginPct != null ? ` (you average ${data.pricing.companyMarginPct}% margin)` : ""}
              </p>
              <ul className="space-y-1">
                {data.pricing.items.map((i) => (
                  <li key={i.label} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                    <span className="text-foreground">
                      {i.label} <span className="text-muted-foreground">{price(i.rateCents)}{i.unitLabel ? ` a ${i.unitLabel}` : ""}</span>
                    </span>
                    <span className={cn(i.underpriced ? "text-amber-600" : "text-muted-foreground")}>
                      {i.jobs} jobs · {i.marginPct != null ? `${i.marginPct}% margin` : "no margin"} · {i.winRatePct != null ? `wins ${i.winRatePct}% of ${i.quotes} quotes` : "no quotes"}
                      {i.proposalCents != null ? ` · would ask ${price(i.proposalCents)} (+${i.proposalPct}%)` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {data.pricing.pending.map((p) => (
                <p key={p.label} className="text-xs text-foreground">
                  Waiting on your Y/N: {p.label} {price(p.oldRateCents)} to {price(p.newRateCents)}.
                </p>
              ))}
              {data.pricing.changes.map((c) => (
                <p key={c.id} className="text-xs text-muted-foreground">
                  {c.label}: raised {price(c.oldRateCents)} to {price(c.newRateCents)} on {day(c.appliedAt.slice(0, 10))} - {c.after.jobs ? `${c.after.jobs} jobs since at ${c.after.marginPct ?? "?"}% margin (was ${c.before.marginPct}%)` : "no jobs since yet"}.
                </p>
              ))}
            </div>
          )}

          {data.lastWeekly?.body && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">Last weekly text ({day(data.lastWeekly.date)})</p>
              <p className="text-xs text-muted-foreground whitespace-pre-line">{data.lastWeekly.body}</p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">{data.disclaimer} Profit uses crew pay rates (Timesheets &gt; Pay rates), materials and receipts on each job.</p>
          {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this or see the numbers.</p>}
          {s.enabledIsDefault && !s.defaultEnabled && <p className="text-xs text-muted-foreground">Off unless you switch it on.</p>}
        </div>
      )}
    </AiFrontDeskSectionCard>
  );
}
