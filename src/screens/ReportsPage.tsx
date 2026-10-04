import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, CalendarCheck, Clock, Download, FileText, Minus, Sparkles, Users, Wallet } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { DashboardCard } from "@/components/ui/DashboardCard";
import { EmptyState, ErrorBanner, SkeletonCard } from "@/components/ui/StateViews";
import { useAuth } from "@/lib/auth-context";
import { formatCents } from "@/lib/invoices-api";
import { hm } from "@/lib/jobs-format";
import { useOrg } from "@/lib/org-context";
import {
  addDaysYmd,
  bucketLabel,
  change,
  METHOD_LABELS,
  overviewCsv,
  PRESETS,
  presetRange,
  rangeLabel,
  useOverview,
  type Compare,
  type OverviewReport,
  type Preset,
} from "@/lib/reports-api";
import { cn } from "@/lib/utils";

const AXIS_TICK = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
const TOOLTIP_STYLE = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 };
const inputCls = "h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground";

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

function compactMoney(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (Math.abs(d) >= 10_000) return `$${Math.round(d / 1_000)}k`;
  if (Math.abs(d) >= 1_000) return `$${(d / 1_000).toFixed(1)}k`;
  return `$${Math.round(d)}`;
}

/** "↑ 12% vs last period" — the arrow and word carry direction, never colour alone. */
function Delta({ c, lowerIsBetter = false }: { c: Compare; lowerIsBetter?: boolean }) {
  const ch = change(c);
  if (ch === null) {
    return <p className="text-[11px] text-muted-foreground mt-0.5">{c.value === 0 ? "None either period" : "None last period"}</p>;
  }
  const flat = Math.abs(ch) < 0.005;
  const up = ch > 0;
  const good = flat ? null : up !== lowerIsBetter;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <p className="text-[11px] mt-0.5 flex flex-wrap items-center gap-x-1">
      <span
        className={cn(
          "inline-flex items-center gap-0.5 font-medium whitespace-nowrap",
          good === null ? "text-muted-foreground" : good ? "text-[hsl(var(--success))]" : "text-destructive",
        )}
      >
        <Icon className="w-3 h-3" aria-hidden />
        {flat ? "Flat" : `${up ? "Up" : "Down"} ${Math.abs(Math.round(ch * 100))}%`}
      </span>
      <span className="text-muted-foreground whitespace-nowrap">vs last period</span>
    </p>
  );
}

function Tile({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 min-w-0">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums text-foreground mt-1 truncate">{value}</p>
      {children}
    </div>
  );
}

function SeriesChart({ r, field, name, money }: { r: OverviewReport; field: "collectedCents" | "jobsCompleted"; name: string; money: boolean }) {
  const data = r.series.map((s) => ({ label: bucketLabel(s.key, r.period.bucket), value: money ? s[field] / 100 : s[field] }));
  const empty = data.every((d) => d.value === 0);
  if (empty) return <p className="text-sm text-muted-foreground py-10 text-center">Nothing in this period yet.</p>;
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.6} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={money ? 48 : 28}
            allowDecimals={false}
            tickFormatter={(v: number) => (money ? compactMoney(v * 100) : String(v))}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }}
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: "hsl(var(--foreground))", fontWeight: 600 }}
            itemStyle={{ color: "hsl(var(--foreground))" }}
            formatter={(v: number) => [money ? formatCents(Math.round(v * 100), r.currency) : String(v), name]}
          />
          <Bar dataKey="value" name={name} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal share bars with the value in text beside each — the bar is never the only carrier. */
function ShareRows({ rows, currency }: { rows: Array<{ key: string; label: string; cents: number; count: number; warn?: boolean }>; currency: string }) {
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex items-center gap-1.5 text-foreground min-w-0">
              {row.warn && row.cents > 0 && <AlertTriangle className="w-3.5 h-3.5 text-[hsl(var(--warning))] shrink-0" aria-label="Overdue" />}
              <span className="truncate">{row.label}</span>
              <span className="text-muted-foreground text-xs">· {row.count}</span>
            </span>
            <span className="tabular-nums font-medium text-foreground">{formatCents(row.cents, currency)}</span>
          </div>
          <div className="h-1.5 mt-1 rounded-full bg-secondary overflow-hidden">
            <div className="h-full rounded-full bg-primary" style={{ width: `${(row.cents / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/50 last:border-0 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium text-foreground">{value}</span>
    </div>
  );
}

function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Report({ r }: { r: OverviewReport }) {
  const cur = r.currency;
  const bucketWord = r.period.bucket === "day" ? "day" : r.period.bucket === "week" ? "week" : "month";
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tile label="Collected" value={formatCents(r.money.collected.value, cur)}>
          <Delta c={r.money.collected} />
        </Tile>
        <Tile label="Invoiced" value={formatCents(r.money.invoiced.value, cur)}>
          <Delta c={r.money.invoiced} />
        </Tile>
        <Tile label="Owed to you today" value={formatCents(r.receivables.outstandingCents, cur)}>
          <p className={cn("text-[11px] mt-0.5", r.receivables.overdueCents > 0 ? "text-foreground" : "text-muted-foreground")}>
            {r.receivables.overdueCents > 0 ? `${formatCents(r.receivables.overdueCents, cur)} overdue` : "Nothing overdue"}
          </p>
        </Tile>
        <Tile label="Jobs done" value={String(r.jobs.completed.value)}>
          <Delta c={r.jobs.completed} />
        </Tile>
        <Tile label="Quote win rate" value={pct(r.quotes.winRate)}>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {r.quotes.sent.value ? `${r.quotes.won} of ${r.quotes.sent.value} sent` : "No quotes sent"}
            {r.quotes.previousWinRate !== null && ` · was ${pct(r.quotes.previousWinRate)}`}
          </p>
        </Tile>
        <Tile label="Crew hours" value={hm(r.crew.minutes.value)}>
          <Delta c={r.crew.minutes} />
        </Tile>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <DashboardCard title={`Money collected per ${bucketWord}`} icon={<Wallet className="w-3.5 h-3.5" />}>
          <SeriesChart r={r} field="collectedCents" name="Collected" money />
        </DashboardCard>
        <DashboardCard title={`Jobs done per ${bucketWord}`} icon={<CalendarCheck className="w-3.5 h-3.5" />}>
          <SeriesChart r={r} field="jobsCompleted" name="Jobs done" money={false} />
        </DashboardCard>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <DashboardCard title="Who owes you" icon={<AlertTriangle className="w-3.5 h-3.5" />} action={<Link to="/invoices" className="text-xs text-primary hover:underline">Invoices</Link>}>
          {r.receivables.openInvoices === 0 ? (
            <p className="text-sm text-muted-foreground">Every invoice is paid up.</p>
          ) : (
            <>
              <ShareRows rows={r.receivables.aging.map((a) => ({ ...a, warn: a.key !== "current" }))} currency={cur} />
              {r.receivables.inTransitCents > 0 && (
                <p className="text-[11px] text-muted-foreground mt-3">{formatCents(r.receivables.inTransitCents, cur)} already sent by customers and clearing.</p>
              )}
            </>
          )}
        </DashboardCard>

        <DashboardCard title="How you were paid" icon={<Wallet className="w-3.5 h-3.5" />}>
          {r.money.byMethod.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments in this period.</p>
          ) : (
            <ShareRows rows={r.money.byMethod.map((m) => ({ key: m.method, label: METHOD_LABELS[m.method] ?? m.method, cents: m.cents, count: m.count }))} currency={cur} />
          )}
        </DashboardCard>

        <DashboardCard title="Sales & jobs" icon={<FileText className="w-3.5 h-3.5" />}>
          <Stat label="Quotes sent" value={r.quotes.sent.value} />
          <Stat label="Quotes still open" value={r.quotes.stillOpen} />
          <Stat label={`Quote value approved (${r.quotes.approvedCount})`} value={formatCents(r.quotes.approvedCents.value, cur)} />
          <Stat label="Average invoice" value={r.money.averageInvoiceCents === null ? "—" : formatCents(r.money.averageInvoiceCents, cur)} />
          <Stat label="Jobs still to do" value={r.jobs.upcoming} />
          <Stat label="No-shows · cancelled" value={`${r.jobs.noShow} · ${r.jobs.cancelled}`} />
          <Stat label="New customers" value={`${r.customers.newCustomers.value} (was ${r.customers.newCustomers.previous})`} />
        </DashboardCard>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <DashboardCard title="Top customers" icon={<Users className="w-3.5 h-3.5" />}>
          {r.topCustomers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">Customer</th>
                  <th className="py-2 pr-3 font-medium text-right">Jobs</th>
                  <th className="py-2 font-medium text-right">Paid</th>
                </tr>
              </thead>
              <tbody>
                {r.topCustomers.map((c) => (
                  <tr key={c.contactId} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3">
                      <Link to={`/crm/${c.contactId}`} className="text-foreground hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{c.jobsCompleted}</td>
                    <td className="py-2 text-right tabular-nums font-medium text-foreground">{formatCents(c.collectedCents, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DashboardCard>

        <DashboardCard
          title="Crew hours"
          icon={<Clock className="w-3.5 h-3.5" />}
          action={<Link to="/timesheets?tab=profit" className="text-xs text-primary hover:underline">Job profit</Link>}
        >
          {r.crew.people.length === 0 ? (
            <p className="text-sm text-muted-foreground">No time logged in this period.</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Person</th>
                    <th className="py-2 pr-3 font-medium text-right">Jobs</th>
                    <th className="py-2 pr-3 font-medium text-right">Hours</th>
                    <th className="py-2 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {r.crew.people.map((p) => (
                    <tr key={p.profileId} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3 text-foreground">{p.name}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{p.jobs}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-foreground">{hm(p.minutes)}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">{p.costCents === null ? "no rate" : formatCents(p.costCents, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {r.crew.labourCostCents !== null && (
                <p className="text-[11px] text-muted-foreground mt-3">
                  Labour cost {formatCents(r.crew.labourCostCents, cur)}
                  {r.crew.missingRateNames.length > 0 && ` — not counting ${r.crew.missingRateNames.join(", ")} (no pay rate set)`}.
                </p>
              )}
            </>
          )}
        </DashboardCard>
      </div>

      <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
        <Sparkles className="w-3 h-3 text-primary mt-0.5 shrink-0" />
        Collected counts payments that have cleared and quote deposits. "Owed to you" and its aging are as of today. Dates follow {r.period.timeZone.replace("_", " ")}.
      </p>
    </div>
  );
}

export default function ReportsPage() {
  const { organizationId, companyId, isValid } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const manager = role === "owner" || role === "admin";

  const [params, setParams] = useSearchParams();
  const preset = (PRESETS.some((p) => p.id === params.get("range")) ? params.get("range") : "this_month") as Preset;
  const [customFrom, setCustomFrom] = useState(params.get("from") ?? presetRange("this_month").from);
  const [customTo, setCustomTo] = useState(params.get("to") ?? addDaysYmd(presetRange("this_month").to, -1));

  const range = useMemo(() => {
    if (preset !== "custom") return presetRange(preset);
    const from = params.get("from") ?? customFrom;
    const lastDay = params.get("to") ?? customTo;
    return { from, to: addDaysYmd(lastDay, 1) };
  }, [preset, params, customFrom, customTo]);

  const query = useMemo(() => ({ ...range, companyId: companyId ?? null }), [range, companyId]);
  const { data, isLoading, isError, error, refetch } = useOverview(organizationId, query, isValid && manager);

  const setPreset = (p: Preset) => {
    const next = new URLSearchParams(params);
    if (p === "this_month") next.delete("range");
    else next.set("range", p);
    if (p === "custom") {
      next.set("from", customFrom);
      next.set("to", customTo);
    } else {
      next.delete("from");
      next.delete("to");
    }
    setParams(next, { replace: true });
  };
  const applyCustom = (from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
    if (from && to && from <= to) {
      const next = new URLSearchParams(params);
      next.set("range", "custom");
      next.set("from", from);
      next.set("to", to);
      setParams(next, { replace: true });
    }
  };

  if (!isValid) {
    return <EmptyState title="Workspace not ready" description="Select an organization to see reports." />;
  }
  if (!manager) {
    return (
      <div className="max-w-[1440px] mx-auto">
        <EmptyState icon={BarChart3} title="Reports are for owners and admins" description="Ask an owner of this workspace if you need these numbers." />
      </div>
    );
  }

  return (
    <div className="max-w-[1440px] mx-auto space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Reports</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {rangeLabel(range.from, range.to)}
            {data && <> · compared with {rangeLabel(data.period.prevFromDate, data.period.prevToDate)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/reports/monthly">
              <CalendarCheck className="w-4 h-4 mr-2" />
              Monthly results
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/reports/attribution">
              <BarChart3 className="w-4 h-4 mr-2" />
              Captured by EmpireVu
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data}
            onClick={() => data && downloadCsv(`report-${range.from}-to-${addDaysYmd(range.to, -1)}.csv`, overviewCsv(data))}
          >
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Date range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className={inputCls}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {preset === "custom" && (
          <>
            <input aria-label="From" type="date" value={customFrom} max={customTo} onChange={(e) => applyCustom(e.target.value, customTo)} className={inputCls} />
            <span className="text-sm text-muted-foreground">to</span>
            <input aria-label="To" type="date" value={customTo} min={customFrom} onChange={(e) => applyCustom(customFrom, e.target.value)} className={inputCls} />
          </>
        )}
      </div>

      {isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : "Couldn't load the report."} onRetry={() => refetch()} />
      ) : isLoading || !data ? (
        <div className="space-y-5">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={5} />
        </div>
      ) : (
        <Report r={data} />
      )}
    </div>
  );
}
