import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarRange, Clock, Headset, Mail, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DashboardCard } from "@/components/ui/DashboardCard";
import { EmptyState, ErrorBanner, SkeletonCard } from "@/components/ui/StateViews";
import { useCompanies } from "@/lib/api-hooks";
import { formatDateTime } from "@/lib/format";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";
import { hoursSavedShort, useWeeklyReport, wholeDollars, type WeeklyReportWeek } from "@/lib/weekly-report-api";

/**
 * Weekly front-desk report — the in-app twin of the Monday text + email: this week so far
 * and the last 8 weeks, from src/server/services/weekly-report (docs/front-desk-ai.md).
 */

function Row({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right">
        <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}

function WeekDetail({ week, assumptions }: { week: WeeklyReportWeek; assumptions: string }) {
  const m = week.metrics;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <div className="rounded-xl p-5 border border-primary/20 bg-gradient-to-br from-primary/10 to-transparent">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <Clock className="w-3 h-3" /> Time saved · estimate
          </p>
          <p className="mt-2 text-4xl font-bold tabular-nums text-foreground">
            {m.hoursSaved.minutes > 0 ? `~${hoursSavedShort(m.hoursSaved.minutes)}` : "0 h"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            of front desk work handled
            {m.hoursSaved.wageValueCents >= 100 && <> — about {wholeDollars(m.hoursSaved.wageValueCents)} of receptionist time</>}.
          </p>
          <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">{assumptions}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            ["Calls answered", String(m.calls.answered)],
            ["Text conversations", String(m.textConversations)],
            ["Jobs booked", String(m.jobsBooked)],
            ["Collected", wholeDollars(m.collected.cents)],
          ].map(([label, value]) => (
            <div key={label} className="bg-secondary/40 rounded-lg p-4">
              <p className="text-2xl font-bold tabular-nums text-foreground">{value}</p>
              <p className="text-xs font-medium text-foreground mt-1">{label}</p>
            </div>
          ))}
        </div>
      </div>

      <DashboardCard title="The details" icon={<Headset className="w-3.5 h-3.5" />} className="lg:col-span-3">
        {!m.hasActivity && (
          <p className="text-sm text-muted-foreground mb-3">
            A quiet week — nothing new came in. Your front desk stays on and answers the moment a call or text arrives.
          </p>
        )}
        <Row
          label="Calls answered by your AI"
          value={String(m.calls.answered)}
          hint={[
            m.calls.afterHours !== null ? `${m.calls.afterHours} after hours` : null,
            m.calls.minutes > 0 ? `${m.calls.minutes} min on the phone` : null,
          ]
            .filter(Boolean)
            .join(" · ") || null}
        />
        <Row label="Customer text conversations handled" value={String(m.textConversations)} />
        <Row label="Things it checked with you first" value={String(m.approvals.asked)} hint={m.approvals.asked ? `${m.approvals.approved} approved` : null} />
        <Row label="Missed calls caught" value={String(m.missedCalls.caught)} hint={m.missedCalls.caught ? `${m.missedCalls.textedBack} texted back` : null} />
        <Row label="New leads" value={String(m.leads)} />
        <Row label="Quotes sent" value={String(m.quotes.sent)} />
        <Row label="Quotes approved" value={String(m.quotes.approved)} hint={m.quotes.approved ? wholeDollars(m.quotes.approvedCents) : null} />
        <Row label="Jobs booked" value={String(m.jobsBooked)} />
        <Row
          label="Deposits & payments collected"
          value={wholeDollars(m.collected.cents)}
          hint={m.collected.deposits + m.collected.payments ? `${m.collected.deposits + m.collected.payments} payments` : null}
        />
        <Row label="Reviews requested" value={String(m.reviewsRequested)} />
      </DashboardCard>
    </div>
  );
}

function sendNote(week: WeeklyReportWeek): string {
  if (week.partial) return "In progress — the report for this week goes out next Monday at 8 am.";
  if (week.send?.status === "sent" && week.send.sentAt) {
    const via = week.send.channels.length ? ` by ${week.send.channels.map((c) => (c === "sms" ? "text" : "email")).join(" and ")}` : "";
    return `Sent${via} ${formatDateTime(week.send.sentAt)}.`;
  }
  if (week.send?.status === "skipped") return "Not sent (nothing to report yet).";
  if (week.send?.status === "failed") return "Sending failed — we'll retry.";
  return "Not sent.";
}

export default function ReportsWeeklyPage() {
  const { organizationId, companyId: selectedCompanyId, isValid } = useOrg();
  const { data: companies } = useCompanies(organizationId);
  const companyId = selectedCompanyId ?? companies?.[0]?.id ?? null;
  const { data, isLoading, isError, refetch } = useWeeklyReport(organizationId, companyId, { weeks: 8, includeCurrent: true });
  const [params, setParams] = useSearchParams();

  const selected = useMemo(() => {
    if (!data) return null;
    const wanted = params.get("week");
    return data.weeks.find((w) => w.weekStart === wanted) ?? data.weeks.find((w) => !w.partial) ?? data.weeks[0] ?? null;
  }, [data, params]);

  if (!isValid) {
    return (
      <div className="max-w-[1440px] mx-auto">
        <EmptyState title="Workspace not ready" description="Select an organization to view the weekly report." />
      </div>
    );
  }

  return (
    <div className="max-w-[1440px] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 opacity-0 animate-fade-in">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Your front desk, week by week</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data?.companyName ?? "Your business"} · calls answered, texts handled, jobs booked — and the time it saved you
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/reports/monthly">
            <CalendarRange className="w-4 h-4 mr-2" />
            Monthly results
          </Link>
        </Button>
      </div>

      {isError && <ErrorBanner message="Failed to load the weekly report." onRetry={() => refetch()} />}

      {companies && companies.length === 0 ? (
        <EmptyState title="No companies yet" description="Add a company to start getting a weekly report." />
      ) : isLoading || !data || !selected ? (
        <SkeletonCard rows={5} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-foreground">
              {selected.label}
              {selected.partial ? " · so far" : ""}
            </h2>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              {data.settings.enabled ? <MessageSquare className="w-3 h-3" /> : <Mail className="w-3 h-3" />}
              {data.settings.enabled ? sendNote(selected) : "The Monday report is off — turn it on in Settings → AI front desk."}
            </p>
          </div>

          <WeekDetail week={selected} assumptions={data.assumptions.text} />

          <DashboardCard title="Last 8 weeks" icon={<CalendarRange className="w-3.5 h-3.5" />}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="font-medium py-2 pr-2">Week</th>
                  <th className="font-medium py-2 px-2 text-right">Calls</th>
                  <th className="font-medium py-2 px-2 text-right">Texts</th>
                  <th className="font-medium py-2 px-2 text-right hidden sm:table-cell">Quotes</th>
                  <th className="font-medium py-2 px-2 text-right">Booked</th>
                  <th className="font-medium py-2 px-2 text-right hidden md:table-cell">Collected</th>
                  <th className="font-medium py-2 pl-2 text-right">Saved*</th>
                </tr>
              </thead>
              <tbody>
                {data.weeks.map((week) => {
                  const m = week.metrics;
                  const active = week.weekStart === selected.weekStart;
                  return (
                    <tr
                      key={week.weekStart}
                      onClick={() => setParams({ week: week.weekStart }, { replace: true })}
                      className={cn(
                        "border-t border-border/50 cursor-pointer hover:bg-secondary/40",
                        active && "bg-primary/5",
                      )}
                    >
                      <td className="py-2 pr-2 whitespace-nowrap">
                        <span className={cn("font-medium", active ? "text-primary" : "text-foreground")}>{week.label}</span>
                        {week.partial && <span className="ml-1 text-[11px] text-muted-foreground">so far</span>}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">{m.calls.answered}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{m.textConversations}</td>
                      <td className="py-2 px-2 text-right tabular-nums hidden sm:table-cell">{m.quotes.sent}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{m.jobsBooked}</td>
                      <td className="py-2 px-2 text-right tabular-nums hidden md:table-cell">{wholeDollars(m.collected.cents)}</td>
                      <td className="py-2 pl-2 text-right tabular-nums whitespace-nowrap">{hoursSavedShort(m.hoursSaved.minutes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-muted-foreground">* Time saved is an estimate. Weeks run Monday to Sunday, {data.timeZone} time.</p>
          </DashboardCard>
        </>
      )}
    </div>
  );
}
