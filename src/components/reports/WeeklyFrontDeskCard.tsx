import { Link } from "react-router-dom";
import { ChevronRight, Clock, Headset, MessageSquareText, PhoneCall, CalendarCheck, Wallet } from "lucide-react";

import { ErrorBanner, SkeletonCard } from "@/components/ui/StateViews";
import { useCompanies } from "@/lib/api-hooks";
import { cn } from "@/lib/utils";
import { hoursSavedShort, useWeeklyReport, wholeDollars, type WeeklyReportWeek } from "@/lib/weekly-report-api";

/**
 * Dashboard "This week" card — what the AI front desk handled this week so far, with last
 * week alongside, linking to /reports/weekly. Same numbers as the Monday report
 * (docs/front-desk-ai.md → "Weekly report"). Self-contained: drop it anywhere on the
 * dashboard with the org id (and the selected company, if any).
 */

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof PhoneCall;
  label: string;
  value: string;
  hint?: string | null;
}) {
  return (
    <div className="rounded-lg bg-secondary/40 p-3 min-w-0">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <p className="text-[11px] font-medium truncate">{label}</p>
      </div>
      <p className="mt-1 text-xl font-bold tabular-nums text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground min-h-[16px] truncate">{hint ?? ""}</p>
    </div>
  );
}

function lastWeekLine(week: WeeklyReportWeek | undefined): string | null {
  if (!week) return null;
  const m = week.metrics;
  if (!m.hasActivity) return `Last week (${week.label}): quiet — nothing new came in.`;
  const parts = [
    `${m.calls.answered} ${m.calls.answered === 1 ? "call" : "calls"}`,
    `${m.textConversations} text ${m.textConversations === 1 ? "chat" : "chats"}`,
    `${m.jobsBooked} booked`,
  ];
  if (m.hoursSaved.minutes > 0) parts.push(`~${hoursSavedShort(m.hoursSaved.minutes)} saved`);
  return `Last week (${week.label}): ${parts.join(" · ")}`;
}

export function WeeklyFrontDeskCard({
  orgId,
  companyId,
  className,
}: {
  orgId: string;
  companyId?: string | null;
  className?: string;
}) {
  const { data: companies } = useCompanies(orgId);
  const effectiveCompanyId = companyId ?? companies?.[0]?.id ?? null;
  const { data, isLoading, isError, refetch } = useWeeklyReport(orgId, effectiveCompanyId, { weeks: 1, includeCurrent: true });

  if (!effectiveCompanyId && companies && companies.length === 0) return null;

  const current = data?.weeks.find((w) => w.partial);
  const last = data?.weeks.find((w) => !w.partial);
  const m = current?.metrics;

  return (
    <section
      className={cn(
        "rounded-xl p-5 bg-card border border-border shadow-md shadow-black/10 opacity-0 animate-fade-in",
        className,
      )}
      style={{ animationDelay: "100ms" }}
      aria-label="Your front desk this week"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex items-center justify-center w-7 h-7 rounded-md bg-primary/15 text-primary shrink-0">
            <Headset className="w-3.5 h-3.5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground tracking-tight">Your front desk this week</h3>
            {current && <p className="text-[11px] text-muted-foreground">{current.label} · so far</p>}
          </div>
        </div>
        <Link
          to="/reports/weekly"
          className="flex items-center gap-0.5 text-xs font-medium text-primary hover:underline shrink-0"
        >
          Weekly report <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {isError ? (
        <div className="mt-4">
          <ErrorBanner message="Couldn't load this week's numbers." onRetry={() => refetch()} />
        </div>
      ) : isLoading || !m ? (
        <div className="mt-4">
          <SkeletonCard rows={2} />
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-3xl font-bold tabular-nums text-foreground">
              {m.hoursSaved.minutes > 0 ? `~${hoursSavedShort(m.hoursSaved.minutes)}` : "0 h"}
            </p>
            <p className="text-sm text-muted-foreground">
              of front desk work handled
              {m.hoursSaved.wageValueCents >= 100 && (
                <> · about {wholeDollars(m.hoursSaved.wageValueCents)} of receptionist time</>
              )}
              <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] align-middle" title={data?.assumptions.text}>
                <Clock className="w-3 h-3" /> estimate
              </span>
            </p>
          </div>

          <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            <Stat
              icon={PhoneCall}
              label="Calls answered"
              value={String(m.calls.answered)}
              hint={m.calls.afterHours ? `${m.calls.afterHours} after hours` : m.missedCalls.textedBack ? `${m.missedCalls.textedBack} missed, texted back` : null}
            />
            <Stat
              icon={MessageSquareText}
              label="Text conversations"
              value={String(m.textConversations)}
              hint={m.approvals.asked ? `${m.approvals.asked} checked with you` : null}
            />
            <Stat
              icon={CalendarCheck}
              label="Jobs booked"
              value={String(m.jobsBooked)}
              hint={m.quotes.sent ? `${m.quotes.sent} ${m.quotes.sent === 1 ? "quote" : "quotes"} sent` : null}
            />
            <Stat
              icon={Wallet}
              label="Collected"
              value={wholeDollars(m.collected.cents)}
              hint={m.quotes.approved ? `${wholeDollars(m.quotes.approvedCents)} approved` : null}
            />
          </div>

          {last && <p className="mt-3 text-xs text-muted-foreground">{lastWeekLine(last)}</p>}
        </>
      )}
    </section>
  );
}

export default WeeklyFrontDeskCard;
