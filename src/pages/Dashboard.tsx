import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Calendar,
  CheckSquare,
  Clock,
  Users,
  Workflow,
  Zap,
} from "lucide-react";

import { EmptyState, ErrorState, LoadingState } from "@/components/system/AsyncState";
import { useAppContext } from "@/lib/app-context";
import { apiRequest, toQueryString } from "@/lib/api";
import { formatCompactCurrency, formatDateTime, formatRelativeTime } from "@/lib/formatters";

interface DashboardSummaryResponse {
  activeWorkflowCount: number;
  failedWorkflowJobCount: number;
  newLeadCount: number;
  overdueTaskCount: number;
  revenueSnapshot: {
    todayCents: number;
    weekCents: number;
  };
  todayBookingCount: number;
  upcomingBookingCount: number;
  urgentTaskCount: number;
}

interface DashboardActivityItem {
  company: { id: string; name: string } | null;
  entity: { id: string; label: string; type: string } | null;
  eventType: string;
  id: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  relatedEntity: { id: string; label: string; type: string } | null;
}

interface AutomationImpactResponse {
  estimatedTimeSavedSeconds: number;
  failedJobsCount: number;
  successRate: number;
  tasksAutoCreated: number;
  totalWorkflowRuns: number;
}

interface TaskRow {
  assignee: { initials: string; name: string } | null;
  company: { id: string; name: string } | null;
  dueAt: string | null;
  id: string;
  isOverdue: boolean;
  priority: string;
  status: string;
  title: string;
}

interface TaskListResponse {
  rows: {
    items: TaskRow[];
  };
}

interface BookingRow {
  company: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  id: string;
  scheduledFor: string;
  status: string;
  taskCount: number;
  title: string;
}

interface CalendarViewResponse {
  bookings: {
    items: BookingRow[];
  };
}

interface CRMRow {
  company: { id: string; name: string } | null;
  id: string;
  name: string;
  nextAction: {
    label: string;
    type: string;
  };
  stage: string;
}

interface CRMContactsResponse {
  rows: {
    items: CRMRow[];
  };
}

function secondsToHours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)}h`;
}

function titleize(value: string): string {
  return value.replace(/[._]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function Dashboard() {
  const { activeCompanyId, activeOrganizationId, organizations } = useAppContext();
  const companyQuery = activeCompanyId ? { companyId: activeCompanyId } : {};
  const summaryQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "dashboard", "summary", activeCompanyId ?? "all"],
    queryFn: () =>
      apiRequest<DashboardSummaryResponse>(
        `/api/organizations/${activeOrganizationId}/ui/dashboard/summary${toQueryString(companyQuery)}`,
      ),
  });
  const activityQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "dashboard", "activity", activeCompanyId ?? "all"],
    queryFn: () => apiRequest<{ items: DashboardActivityItem[] }>(
      `/api/organizations/${activeOrganizationId}/ui/dashboard/activity${toQueryString({
        ...companyQuery,
        limit: 6,
        page: 1,
      })}`,
    ),
  });
  const automationQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "dashboard", "automation-impact", activeCompanyId ?? "all"],
    queryFn: () =>
      apiRequest<AutomationImpactResponse>(
        `/api/organizations/${activeOrganizationId}/ui/dashboard/automation-impact${toQueryString(companyQuery)}`,
      ),
  });
  const tasksQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "tasks", "dashboard", activeCompanyId ?? "all"],
    queryFn: () => apiRequest<TaskListResponse>(
      `/api/organizations/${activeOrganizationId}/ui/tasks${toQueryString({
        ...companyQuery,
        limit: 5,
        page: 1,
        status: "todo",
      })}`,
    ),
  });
  const bookingsQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "calendar", "dashboard", activeCompanyId ?? "all"],
    queryFn: () => apiRequest<CalendarViewResponse>(
      `/api/organizations/${activeOrganizationId}/ui/calendar${toQueryString({
        ...companyQuery,
        limit: 5,
        page: 1,
      })}`,
    ),
  });
  const crmQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "crm", "dashboard", activeCompanyId ?? "all"],
    queryFn: () => apiRequest<CRMContactsResponse>(
      `/api/organizations/${activeOrganizationId}/ui/crm/contacts${toQueryString({
        ...companyQuery,
        limit: 5,
        page: 1,
      })}`,
    ),
  });

  if (summaryQuery.isLoading) {
    return <LoadingState label="Loading dashboard metrics..." />;
  }

  if (summaryQuery.error) {
    return (
      <ErrorState
        description={summaryQuery.error instanceof Error ? summaryQuery.error.message : "Unable to load the dashboard."}
        onRetry={() => summaryQuery.refetch()}
        title="Dashboard unavailable"
      />
    );
  }

  const summary = summaryQuery.data;
  const activityItems = activityQuery.data?.items ?? [];
  const taskItems = tasksQuery.data?.rows.items ?? [];
  const bookingItems = bookingsQuery.data?.bookings.items ?? [];
  const crmItems = crmQuery.data?.rows.items ?? [];
  const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Command Center</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {activeOrganization?.name ?? "Active organization"}
            {activeCompanyId ? " - Company scope applied" : " - All companies"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          Metrics and operational lists now reflect live organization data.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            icon: CheckSquare,
            label: "Overdue Tasks",
            value: summary.overdueTaskCount,
          },
          {
            icon: Calendar,
            label: "Upcoming Bookings",
            value: summary.upcomingBookingCount,
          },
          {
            icon: Users,
            label: "Lead Contacts",
            value: summary.newLeadCount,
          },
          {
            icon: Workflow,
            label: "Failed Queue Jobs",
            value: summary.failedWorkflowJobCount,
          },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-secondary p-2 text-primary">
                <item.icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">{item.label}</p>
                <p className="text-2xl font-semibold text-foreground">{item.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">System Activity</h2>
              <p className="text-xs text-muted-foreground">Recent activity events across the active scope.</p>
            </div>
            <Activity className="h-4 w-4 text-primary" />
          </div>
          {activityQuery.isLoading ? <LoadingState label="Loading recent activity..." /> : null}
          {activityQuery.error ? (
            <ErrorState
              description={activityQuery.error instanceof Error ? activityQuery.error.message : "Unable to load recent activity."}
              onRetry={() => activityQuery.refetch()}
              title="Activity unavailable"
            />
          ) : null}
          {!activityQuery.isLoading && !activityQuery.error && activityItems.length === 0 ? (
            <EmptyState
              description="New activity events will appear here as contacts, bookings, tasks, and workflows change."
              title="No activity yet"
            />
          ) : null}
          {!activityQuery.isLoading && !activityQuery.error && activityItems.length > 0 ? (
            <div className="space-y-3">
              {activityItems.map((item) => (
                <div key={item.id} className="rounded-lg border border-border/60 bg-background/40 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{titleize(item.eventType)}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.entity?.label ?? item.relatedEntity?.label ?? "System event"}
                        {item.company?.name ? ` · ${item.company.name}` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatRelativeTime(item.occurredAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Automation Impact</h2>
              <p className="text-xs text-muted-foreground">Queue and workflow health for internal operations.</p>
            </div>
            <Zap className="h-4 w-4 text-primary" />
          </div>
          {automationQuery.isLoading ? <LoadingState label="Loading workflow impact..." /> : null}
          {automationQuery.error ? (
            <ErrorState
              description={automationQuery.error instanceof Error ? automationQuery.error.message : "Unable to load automation impact."}
              onRetry={() => automationQuery.refetch()}
              title="Automation impact unavailable"
            />
          ) : null}
          {automationQuery.data ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-secondary/60 p-3">
                <p className="text-xs text-muted-foreground">Workflow Runs</p>
                <p className="text-lg font-semibold text-foreground">{automationQuery.data.totalWorkflowRuns}</p>
              </div>
              <div className="rounded-lg bg-secondary/60 p-3">
                <p className="text-xs text-muted-foreground">Success Rate</p>
                <p className="text-lg font-semibold text-foreground">{automationQuery.data.successRate}%</p>
              </div>
              <div className="rounded-lg bg-secondary/60 p-3">
                <p className="text-xs text-muted-foreground">Tasks Auto-Created</p>
                <p className="text-lg font-semibold text-foreground">{automationQuery.data.tasksAutoCreated}</p>
              </div>
              <div className="rounded-lg bg-secondary/60 p-3">
                <p className="text-xs text-muted-foreground">Time Saved</p>
                <p className="text-lg font-semibold text-foreground">{secondsToHours(automationQuery.data.estimatedTimeSavedSeconds)}</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Open Tasks</h2>
            <AlertTriangle className="h-4 w-4 text-primary" />
          </div>
          {tasksQuery.isLoading ? <LoadingState label="Loading open tasks..." /> : null}
          {tasksQuery.error ? (
            <ErrorState
              description={tasksQuery.error instanceof Error ? tasksQuery.error.message : "Unable to load tasks."}
              onRetry={() => tasksQuery.refetch()}
              title="Tasks unavailable"
            />
          ) : null}
          {!tasksQuery.isLoading && !tasksQuery.error && taskItems.length === 0 ? (
            <EmptyState description="Tasks created by users and workflows will appear here." title="No open tasks" />
          ) : null}
          {!tasksQuery.isLoading && !tasksQuery.error && taskItems.length > 0 ? (
            <div className="space-y-3">
              {taskItems.map((task) => (
                <div key={task.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{task.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.company?.name ?? "No company"}
                        {task.assignee?.name ? ` · ${task.assignee.name}` : " · Unassigned"}
                      </p>
                    </div>
                    <span className={`text-xs ${task.isOverdue ? "text-destructive" : "text-muted-foreground"}`}>
                      {task.dueAt ? formatDateTime(task.dueAt) : "No due date"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Upcoming Bookings</h2>
            <Clock className="h-4 w-4 text-primary" />
          </div>
          {bookingsQuery.isLoading ? <LoadingState label="Loading bookings..." /> : null}
          {bookingsQuery.error ? (
            <ErrorState
              description={bookingsQuery.error instanceof Error ? bookingsQuery.error.message : "Unable to load bookings."}
              onRetry={() => bookingsQuery.refetch()}
              title="Bookings unavailable"
            />
          ) : null}
          {!bookingsQuery.isLoading && !bookingsQuery.error && bookingItems.length === 0 ? (
            <EmptyState description="Upcoming bookings will appear once the organization starts scheduling work." title="No bookings scheduled" />
          ) : null}
          {!bookingsQuery.isLoading && !bookingsQuery.error && bookingItems.length > 0 ? (
            <div className="space-y-3">
              {bookingItems.map((booking) => (
                <div key={booking.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                  <p className="text-sm font-medium text-foreground">{booking.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(booking.scheduledFor)}
                    {booking.company?.name ? ` · ${booking.company.name}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {booking.contact?.name ?? "No linked contact"} · {booking.taskCount} linked task{booking.taskCount === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">CRM Focus</h2>
            <Users className="h-4 w-4 text-primary" />
          </div>
          {crmQuery.isLoading ? <LoadingState label="Loading CRM pipeline..." /> : null}
          {crmQuery.error ? (
            <ErrorState
              description={crmQuery.error instanceof Error ? crmQuery.error.message : "Unable to load CRM contacts."}
              onRetry={() => crmQuery.refetch()}
              title="CRM unavailable"
            />
          ) : null}
          {!crmQuery.isLoading && !crmQuery.error && crmItems.length === 0 ? (
            <EmptyState description="New contacts will appear here once the CRM starts receiving data." title="No contacts yet" />
          ) : null}
          {!crmQuery.isLoading && !crmQuery.error && crmItems.length > 0 ? (
            <div className="space-y-3">
              {crmItems.map((contact) => (
                <div key={contact.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                  <p className="text-sm font-medium text-foreground">{contact.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {contact.company?.name ?? "No company"} · {titleize(contact.stage)}
                  </p>
                  <p className="mt-1 text-xs text-primary">Next: {contact.nextAction.label}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Revenue Today</p>
          <p className="mt-2 text-xl font-semibold text-foreground">{formatCompactCurrency(summary.revenueSnapshot.todayCents)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Revenue This Week</p>
          <p className="mt-2 text-xl font-semibold text-foreground">{formatCompactCurrency(summary.revenueSnapshot.weekCents)}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Today&apos;s Bookings</p>
          <p className="mt-2 text-xl font-semibold text-foreground">{summary.todayBookingCount}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Urgent Tasks</p>
          <p className="mt-2 text-xl font-semibold text-foreground">{summary.urgentTaskCount}</p>
        </div>
      </div>
    </div>
  );
}
