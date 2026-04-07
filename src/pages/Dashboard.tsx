import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
  Building2,
  AlertCircle,
} from "lucide-react";
import { DashboardCard, StatCard } from "@/components/ui/DashboardCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { useAuth } from "@/lib/auth-context";
import {
  useDashboardSummary,
  useDashboardActivity,
  useAutomationImpact,
  useOrganizations,
  useCompanies
} from "@/lib/api-hooks";
import { SkeletonStatCard, SkeletonCard, ErrorBanner, EmptyState, LoadingCards } from "@/components/ui/StateViews";
import { relativeTime, formatCentsCompact, formatSeconds, formatPercent } from "@/lib/format";
import type { DashboardActivityItem } from "@/lib/api-client";

function NoOrgContextState() {
  const navigate = useNavigate();
  const { status } = useAuth();
  const { requiresOnboarding } = useOrg();

  return (
    <div className="max-w-[1440px] mx-auto space-y-6">
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
            <Building2 className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="text-center space-y-2">
            <h2 className="text-xl font-semibold">Workspace Not Ready</h2>
            <p className="text-muted-foreground max-w-md">
              {status === "unauthenticated" ? (
                "Please sign in to access your workspace."
              ) : requiresOnboarding ? (
                "You need to complete onboarding before accessing the dashboard."
              ) : (
                "Your organization context is invalid. Please try refreshing the page."
              )}
            </p>
          </div>
          <div className="flex gap-3">
            {status === "authenticated" && requiresOnboarding && (
              <Button onClick={() => navigate("/onboarding")}>
                Complete Onboarding
              </Button>
            )}
            {status === "unauthenticated" && (
              <Button onClick={() => navigate("/signin")}>
                Sign In
              </Button>
            )}
            <Button variant="outline" onClick={() => window.location.reload()}>
              Refresh Page
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DashboardErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="max-w-[1440px] mx-auto space-y-6">
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-destructive" />
          </div>
          <div className="text-center space-y-2">
            <h2 className="text-xl font-semibold">Dashboard Load Failed</h2>
            <p className="text-muted-foreground max-w-md">{message}</p>
          </div>
          {onRetry && (
            <Button variant="outline" onClick={onRetry}>
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
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
  const navigate = useNavigate();

  const handleClick = () => {
    if (!item.entity) return;
    if (item.entity.type === "contact") navigate(`/crm/${item.entity.id}`);
    if (item.entity.type === "booking") navigate("/calendar");
    if (item.entity.type === "task") navigate("/tasks");
    if (item.entity.type === "workflow") navigate("/automations");
  };

  return (
    <div 
      onClick={handleClick}
      className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer group"
    >
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-primary/10 group-hover:bg-primary/20 transition-colors">
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
      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors self-center" />
    </div>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const { organizationId, companyId, isValid } = useOrg();
  const activityParams = companyId != null ? { companyId, limit: 10 } : { limit: 10 };

  const summary = useDashboardSummary(organizationId);
  const activity = useDashboardActivity(organizationId, activityParams);
  const impact = useAutomationImpact(organizationId);
  const { data: orgs } = useOrganizations();
  const { data: companies } = useCompanies(organizationId);

  if (!isValid) {
    return <NoOrgContextState />;
  }

  if (summary.isError && summary.error instanceof Error && summary.error.message.includes("401")) {
    return <DashboardErrorState message="Authentication required. Please sign in again." />;
  }

  if (summary.isError && summary.error instanceof Error && summary.error.message.includes("403")) {
    return <DashboardErrorState message="You don't have access to this organization." />;
  }

  const s = summary.data;
  const imp = impact.data;
  const activityItems = activity.data ?? [];

  const currentOrgName = orgs?.find(o => o.id === organizationId)?.name ?? "Organization";
  const currentCompanyName = !companyId ? "All Companies" : (companies?.find(c => c.id === companyId)?.name ?? "Filtered");

  return (
    <div className="max-w-[1440px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Command Center</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {currentOrgName} · {currentCompanyName} · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
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
          action={<button onClick={() => navigate("/crm")} className="text-xs text-primary hover:underline font-medium">View all</button>}
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
              { label: "New Booking", icon: Calendar, primary: true, path: "/calendar" },
              { label: "New Task", icon: CheckSquare, primary: false, path: "/tasks" },
              { label: "Add Lead", icon: UserPlus, primary: false, path: "/crm" },
              { label: "Settings", icon: FileText, primary: false, path: "/settings" },
            ].map((action, i) => (
              <button
                key={i}
                onClick={() => navigate(action.path)}
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
