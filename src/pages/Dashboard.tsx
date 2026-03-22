import {
  Calendar,
  CheckSquare,
  Users,
  AlertTriangle,
  Clock,
  Zap,
  TrendingUp,
  FileText,
  UserPlus,
  Activity,
  CircleDot,
  ChevronRight,
} from "lucide-react";
import { DashboardCard, StatCard } from "@/components/ui/DashboardCard";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { useDashboardSummary, useDashboardActivity, useAutomationImpact } from "@/lib/api-hooks";
import { SkeletonStatCard, SkeletonCard, ErrorBanner, EmptyState, LoadingCards } from "@/components/ui/StateViews";
import { relativeTime, formatCentsCompact, formatSeconds, formatPercent } from "@/lib/format";
import type { DashboardActivityItem } from "@/lib/api-client";

// ─── Company colour mapping ──────────────────────────────────────────────────

const companyColors: Record<string, string> = {
  "A1 Marine Care": "hsl(195 80% 50%)",
  RankLocal: "hsl(152 60% 48%)",
  MarineMecca: "hsl(38 92% 55%)",
  Vitatee: "hsl(280 70% 58%)",
};

function CompanyTag({ name }: { name: string }) {
  const color = companyColors[name];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color ?? "hsl(var(--muted-foreground))" }} />
      {name}
    </span>
  );
}

// ─── Event type config ───────────────────────────────────────────────────────

const eventTypeConfig: Record<string, { label: string; color: string }> = {
  booking_created: { label: "Booking created", color: "text-primary" },
  booking_completed: { label: "Booking completed", color: "text-[hsl(var(--success))]" },
  task_created: { label: "Task created", color: "text-[hsl(var(--warning))]" },
  task_completed: { label: "Task completed", color: "text-[hsl(var(--success))]" },
  contact_created: { label: "Contact added", color: "text-primary" },
  contact_updated: { label: "Contact updated", color: "text-primary" },
  workflow_triggered: { label: "Workflow triggered", color: "text-[hsl(var(--accent-violet))]" },
  stage_changed: { label: "Stage changed", color: "text-[hsl(var(--accent-violet))]" },
  payment_received: { label: "Payment received", color: "text-[hsl(var(--success))]" },
};

function ActivityFeedItem({ item }: { item: DashboardActivityItem }) {
  const cfg = eventTypeConfig[item.eventType] ?? { label: item.eventType, color: "text-muted-foreground" };
  const companyName = item.company?.name ?? "";

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-primary/10">
        <Activity className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground leading-snug">
          <span className="font-medium">{cfg.label}</span>
          {item.entity && (
            <span className="text-foreground/70"> · {item.entity.label}</span>
          )}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {companyName && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-muted-foreground" />
              {companyName}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/50">·</span>
          <span className="text-[10px] text-muted-foreground/50">{relativeTime(item.occurredAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { organizationId, companyId } = useOrg();
  const activityParams = companyId !== "all" ? { companyId, limit: 10 } : { limit: 10 };

  const summary = useDashboardSummary(organizationId);
  const activity = useDashboardActivity(organizationId, activityParams);
  const impact = useAutomationImpact(organizationId);

  const s = summary.data;
  const imp = impact.data;
  const activityItems = activity.data ?? [];

  return (
    <div className="max-w-[1440px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Command Center</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Thinker Holdings · {companyId === "all" ? "All Companies" : "Filtered"} · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-muted-foreground">
            <CircleDot className="w-3 h-3 text-success" />
            <span>{s ? `${s.activeWorkflowCount} workflows active` : "Loading..."}</span>
          </div>
        </div>
      </div>

      {/* Error banners */}
      {summary.isError && (
        <ErrorBanner message="Failed to load dashboard summary." onRetry={() => summary.refetch()} />
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        {summary.isLoading ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <StatCard
              label="Overdue Tasks"
              value={s ? String(s.overdueTaskCount) : "—"}
              change={s ? `${s.urgentTaskCount} urgent` : ""}
              positive={false}
              icon={<CheckSquare className="w-3.5 h-3.5" />}
            />
            <StatCard
              label="New Leads"
              value={s ? String(s.newLeadCount) : "—"}
              change="in pipeline"
              positive
              icon={<Users className="w-3.5 h-3.5" />}
            />
            <StatCard
              label="Revenue (Today)"
              value={s ? formatCentsCompact(s.revenueSnapshot.todayCents) : "—"}
              change={s ? `${formatCentsCompact(s.revenueSnapshot.weekCents)} this week` : ""}
              positive
              icon={<TrendingUp className="w-3.5 h-3.5" />}
            />
            <StatCard
              label="Bookings Today"
              value={s ? String(s.todayBookingCount) : "—"}
              change={s ? `${s.upcomingBookingCount} upcoming` : ""}
              positive
              icon={<AlertTriangle className="w-3.5 h-3.5" />}
            />
          </>
        )}
      </div>

      {/* ═══ SYSTEM ACTIVITY FEED ═══ */}
      <section className="space-y-4 opacity-0 animate-fade-in" style={{ animationDelay: "150ms" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-primary" />
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              System Activity
            </h2>
            {!activity.isLoading && (
              <span className="text-[9px] font-bold text-primary bg-primary/10 rounded-full w-4 h-4 flex items-center justify-center">
                {activityItems.length}
              </span>
            )}
          </div>
          {imp && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Zap className="w-3 h-3 text-[hsl(var(--accent-violet))]" />
                <span className="font-semibold text-foreground tabular-nums">{imp.totalWorkflowRuns}</span>
                <span>Workflows Active</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <CheckSquare className="w-3 h-3 text-[hsl(var(--success))]" />
                <span className="font-semibold text-foreground tabular-nums">{imp.tasksAutoCreated}</span>
                <span>Tasks Auto-Created</span>
              </div>
            </div>
          )}
        </div>
        <DashboardCard
          title="Live Activity Feed"
          icon={<Zap className="w-3.5 h-3.5" />}
          action={<button className="text-xs text-primary hover:underline font-medium">View all</button>}
        >
          {activity.isLoading ? (
            <LoadingCards count={3} />
          ) : activity.isError ? (
            <div className="px-3 py-2">
              <ErrorBanner message="Failed to load activity." onRetry={() => activity.refetch()} />
            </div>
          ) : activityItems.length === 0 ? (
            <EmptyState title="No recent activity" description="Events will appear here as they occur." />
          ) : (
            <div className="space-y-0.5">
              {activityItems.slice(0, 8).map((item) => (
                <ActivityFeedItem key={item.id} item={item} />
              ))}
            </div>
          )}
        </DashboardCard>
      </section>

      {/* ═══ TIER 3: INSIGHTS / PASSIVE ═══ */}
      <section className="space-y-4 opacity-0 animate-fade-in" style={{ animationDelay: "270ms" }}>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
          Insights
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Automation Impact */}
          <DashboardCard
            title="Automation Impact"
            icon={<Zap className="w-3.5 h-3.5" />}
            className="lg:col-span-3"
            variant="elevated"
          >
            {impact.isLoading ? (
              <SkeletonCard rows={2} />
            ) : impact.isError ? (
              <ErrorBanner message="Failed to load automation impact." onRetry={() => impact.refetch()} />
            ) : imp ? (
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-secondary/40 rounded-lg p-3 text-center">
                  <p className="text-lg font-bold text-foreground tabular-nums">{imp.tasksAutoCreated}</p>
                  <p className="text-[10px] text-muted-foreground">Tasks auto-created</p>
                </div>
                <div className="bg-secondary/40 rounded-lg p-3 text-center">
                  <p className="text-lg font-bold text-[hsl(var(--success))] tabular-nums">
                    {formatSeconds(imp.estimatedTimeSavedSeconds)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Time saved (est.)</p>
                </div>
                <div className="bg-secondary/40 rounded-lg p-3 text-center">
                  <p className="text-lg font-bold text-[hsl(var(--accent-violet))] tabular-nums">
                    {formatPercent(imp.successRate)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Success rate</p>
                </div>
              </div>
            ) : null}
          </DashboardCard>
        </div>
      </section>

      {/* Quick Actions */}
      <section className="opacity-0 animate-fade-in" style={{ animationDelay: "330ms" }}>
        <div className="p-5 rounded-xl bg-[hsl(var(--card-elevated))] border border-border shadow-md shadow-black/10">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="flex items-center justify-center w-7 h-7 rounded-md bg-primary/10 text-primary">
              <Zap className="w-3.5 h-3.5" />
            </span>
            <h3 className="text-sm font-semibold text-foreground tracking-tight">Quick Actions</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "New Booking", icon: Calendar, primary: true },
              { label: "New Task", icon: CheckSquare, primary: false },
              { label: "Add Lead", icon: UserPlus, primary: false },
              { label: "Create Invoice", icon: FileText, primary: false },
            ].map((action, i) => (
              <button
                key={i}
                className={cn(
                  "flex items-center gap-2.5 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-150 active:scale-[0.97]",
                  action.primary
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-md shadow-primary/20"
                    : "bg-secondary hover:bg-surface-3 text-foreground"
                )}
              >
                <action.icon className="w-4 h-4" />
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
