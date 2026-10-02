import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck, Lightbulb, ListChecks, Loader2, Mail, TrendingUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DashboardCard } from "@/components/ui/DashboardCard";
import { EmptyState, ErrorBanner, SkeletonCard } from "@/components/ui/StateViews";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { useCompanies, useMonthlyScorecard, useUpdateMonthlyScorecard } from "@/lib/api-hooks";
import type { MonthlyScorecard, ScorecardLeadSource, ScorecardMetricDelta } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Monthly results — the in-app twin of the monthly scorecard email: this month so far and
 * last month, computed by the same service (src/server/services/monthly-scorecard).
 */

const SOURCE_LABELS: Record<ScorecardLeadSource, string> = {
  web_form: "Web form",
  phone_ai: "Phone (AI receptionist)",
  missed_call: "Missed-call catcher",
  text: "Text message",
  referral: "Referral",
  other: "Other / manual",
};

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: currency || "CAD", maximumFractionDigits: 0 }).format(
    cents / 100,
  );
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "< 1 min";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function DeltaBadge({ delta, label, money: asMoney, currency, lowerIsBetter }: {
  delta: ScorecardMetricDelta | null | undefined;
  label: string;
  money?: boolean;
  currency?: string;
  lowerIsBetter?: boolean;
}) {
  if (!delta) return null;
  if (delta.change === 0) return <span className="text-[11px] text-muted-foreground">same as {label}</span>;
  const up = delta.change > 0;
  const good = lowerIsBetter ? !up : up;
  const magnitude = asMoney ? money(Math.abs(delta.change), currency ?? "CAD") : String(Math.abs(delta.change));
  return (
    <span className={cn("text-[11px] font-medium", good ? "text-[hsl(var(--success))]" : "text-[hsl(var(--warning))]")}>
      {up ? "▲" : "▼"} {magnitude} vs {label}
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="bg-secondary/40 rounded-lg p-4">
      <p className="text-2xl font-bold tabular-nums text-foreground">{value}</p>
      <p className="text-xs font-medium text-foreground mt-1">{label}</p>
      <div className="mt-0.5 min-h-[16px]">{children}</div>
    </div>
  );
}

function DetailRow({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
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

function OperatorNoteEditor({ orgId, card }: { orgId: string; card: MonthlyScorecard }) {
  const update = useUpdateMonthlyScorecard(orgId);
  const [draft, setDraft] = useState(card.operatorNote ?? "");
  useEffect(() => setDraft(card.operatorNote ?? ""), [card.operatorNote, card.month]);
  const dirty = draft.trim() !== (card.operatorNote ?? "");
  return (
    <div className="mt-4 space-y-2">
      <label className="text-xs font-medium text-foreground" htmlFor={`note-${card.month}`}>
        Operator note for {card.monthLabel} (shown in the email)
      </label>
      <Textarea
        id={`note-${card.month}`}
        value={draft}
        maxLength={2000}
        rows={3}
        placeholder="e.g. We're rewriting your quote follow-up text this month."
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        disabled={!dirty || update.isPending}
        onClick={() =>
          update.mutate(
            { companyId: card.companyId, month: card.month, operatorNote: draft.trim() || null },
            {
              onSuccess: () => toast.success("Note saved"),
              onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save the note"),
            },
          )
        }
      >
        {update.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
        Save note
      </Button>
    </div>
  );
}

function ScorecardBody({ card, orgId, canManage }: { card: MonthlyScorecard; orgId: string; canManage: boolean }) {
  const m = card.metrics;
  const d = card.deltas;
  const prevLabel = useMemo(() => {
    const [year, month] = card.month.split("-").map(Number);
    return new Date(Date.UTC(year, month - 2, 15)).toLocaleString("en-CA", { month: "short", timeZone: "UTC" });
  }, [card.month]);
  const currency = m.quotes.currency;
  const sources = (Object.keys(SOURCE_LABELS) as ScorecardLeadSource[]).filter((key) => m.leads.bySource[key] > 0);

  return (
    <div className="space-y-6">
      {card.firstMonth && (
        <p className="text-sm text-muted-foreground">
          First month on the scorecard — next month you'll see how {card.monthLabel} compares.
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Leads caught" value={String(m.leads.total)}>
          <DeltaBadge delta={d?.leads} label={prevLabel} />
        </Tile>
        <Tile label="Replies sent" value={String(m.messages.sent)}>
          <DeltaBadge delta={d?.messagesSent} label={prevLabel} />
        </Tile>
        <Tile label="Jobs booked" value={String(m.jobsBooked)}>
          <DeltaBadge delta={d?.jobsBooked} label={prevLabel} />
        </Tile>
        <Tile label="Revenue collected" value={money(m.attributedRevenue.paidCents, currency)}>
          <DeltaBadge delta={d?.attributedPaidCents} label={prevLabel} money currency={currency} />
        </Tile>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DashboardCard title="The details" icon={<ListChecks className="w-3.5 h-3.5" />}>
          <DetailRow label="Missed calls caught" value={String(m.missedCalls.caught)} hint={`${m.missedCalls.textedBack} texted back`} />
          <DetailRow
            label="Replies sent"
            value={String(m.messages.sent)}
            hint={`${m.messages.automated} automatic · ${m.messages.sms} text · ${m.messages.email} email`}
          />
          <DetailRow
            label="Median first response"
            value={duration(m.firstResponse.medianSeconds)}
            hint={m.firstResponse.responded > 0 ? `${m.firstResponse.within5Min} of ${m.firstResponse.responded} answered within 5 min` : null}
          />
          <DetailRow label="Quotes sent" value={String(m.quotes.sent)} />
          <DetailRow label="Quotes approved" value={String(m.quotes.approved)} hint={money(m.quotes.approvedCents, currency)} />
          <DetailRow label="Deposits collected" value={String(m.quotes.depositsCollected)} hint={money(m.quotes.depositCents, currency)} />
          <DetailRow label="Jobs booked" value={String(m.jobsBooked)} hint={`${m.jobsCompleted} completed`} />
          <DetailRow label="Reviews requested" value={String(m.reviewsRequested)} />
          <DetailRow label="Automations run" value={String(m.automationsRun)} />
          {(m.receptionist.callsHandled > 0 || m.receptionist.minutes > 0) && (
            <DetailRow label="AI receptionist calls" value={String(m.receptionist.callsHandled)} hint={`${m.receptionist.minutes} min`} />
          )}
          <DetailRow
            label="Revenue attributed"
            value={money(m.attributedRevenue.paidCents, currency)}
            hint={`collected · ${money(m.attributedRevenue.approvedCents, currency)} approved`}
          />
        </DashboardCard>

        <div className="space-y-6">
          <DashboardCard title="Leads by source" icon={<TrendingUp className="w-3.5 h-3.5" />}>
            {sources.length === 0 ? (
              <EmptyState title="No new leads" description="New leads for the month will be broken down here." />
            ) : (
              <div className="space-y-2.5">
                {sources.map((key) => (
                  <div key={key}>
                    <div className="flex justify-between text-sm">
                      <span className="text-foreground">{SOURCE_LABELS[key]}</span>
                      <span className="tabular-nums font-medium">{m.leads.bySource[key]}</span>
                    </div>
                    <div className="h-1.5 rounded bg-secondary mt-1">
                      <div className="h-1.5 rounded bg-primary" style={{ width: `${Math.round((m.leads.bySource[key] / m.leads.total) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DashboardCard>

          <DashboardCard title="What we're tuning next" icon={<Lightbulb className="w-3.5 h-3.5" />}>
            {card.suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything's running well — we'll keep watching response times and follow-ups.</p>
            ) : (
              <ol className="list-decimal pl-5 space-y-2 text-sm">
                {card.suggestions.map((s) => (
                  <li key={s.id}>
                    <span className="font-medium text-foreground">{s.title}.</span>{" "}
                    <span className="text-muted-foreground">{s.detail}</span>
                  </li>
                ))}
              </ol>
            )}
            {card.operatorNote && !canManage && (
              <p className="mt-4 text-sm whitespace-pre-line border-l-2 border-primary pl-3">{card.operatorNote}</p>
            )}
            {canManage && <OperatorNoteEditor orgId={orgId} card={card} />}
          </DashboardCard>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
        <Mail className="w-3 h-3" />
        {card.lastSend?.status === "sent" && card.lastSend.sentAt
          ? `Emailed to the owner ${formatDateTime(card.lastSend.sentAt)}.`
          : card.partial
            ? "This month's scorecard is emailed on the 1st of next month."
            : card.lastSend
              ? `Email status: ${card.lastSend.status}.`
              : "Not emailed yet."}{" "}
        Times are in {card.timeZone}. See docs/monthly-scorecard.md for how each number is defined.
      </p>
    </div>
  );
}

export default function ReportsMonthlyPage() {
  const { organizationId, companyId: selectedCompanyId, isValid } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies } = useCompanies(organizationId);
  const companyId = selectedCompanyId ?? companies?.[0]?.id ?? null;
  const { data, isLoading, isError, refetch } = useMonthlyScorecard(organizationId, companyId);
  const update = useUpdateMonthlyScorecard(organizationId);
  const [tab, setTab] = useState(0);

  if (!isValid) {
    return (
      <div className="max-w-[1440px] mx-auto">
        <EmptyState title="Workspace not ready" description="Select an organization to view monthly results." />
      </div>
    );
  }

  const card = data?.months[tab];

  return (
    <div className="max-w-[1440px] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Monthly results</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data?.companyName ?? "Your business"} · leads caught, replies sent, jobs booked — and what we're tuning next
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/reports/attribution">
              <CalendarCheck className="w-4 h-4 mr-2" />
              Captured revenue
            </Link>
          </Button>
        </div>
      </div>

      {isError && <ErrorBanner message="Failed to load monthly results." onRetry={() => refetch()} />}

      {data && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5 bg-secondary/30">
            {data.months.map((month, index) => (
              <button
                key={month.month}
                type="button"
                onClick={() => setTab(index)}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-md transition-colors",
                  tab === index ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {month.monthLabelLong}
                {month.partial ? " (so far)" : ""}
              </button>
            ))}
          </div>
          {canManage && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                checked={data.settings.enabled}
                disabled={update.isPending}
                onCheckedChange={(enabled) =>
                  update.mutate(
                    { companyId: data.companyId, enabled },
                    { onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update") },
                  )
                }
              />
              Email the scorecard to the owner monthly
            </label>
          )}
        </div>
      )}

      {companies && companies.length === 0 ? (
        <EmptyState title="No companies yet" description="Add a company to start tracking monthly results." />
      ) : isLoading || !companyId ? (
        <SkeletonCard rows={4} />
      ) : card ? (
        <ScorecardBody card={card} orgId={organizationId} canManage={canManage} />
      ) : null}
    </div>
  );
}
