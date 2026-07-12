import { useState, useMemo } from "react";
import {
  Plus, Zap, ArrowRight, MoreHorizontal, Search, Filter, Play, Pause,
  ChevronRight, Calendar, UserPlus, CheckCircle2, Bell, ClipboardList,
  Target, Mail, Clock, AlertTriangle, Building2, Globe, X,
  Repeat, Settings2, TrendingUp, Eye, RotateCcw, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import {
  useWorkflows,
  useWorkflowDetail,
  useAutomationImpact,
  useRunWorkflowNow,
  useTriggerWorkflow,
  useRunWorkflowTest,
  useRetryWorkflowJob,
  useUpdateWorkflowStatus,
  useCompanies,
} from "@/lib/api-hooks";
import { SkeletonCard, ErrorBanner, EmptyState } from "@/components/ui/StateViews";
import { relativeTime, formatPercent, formatSeconds } from "@/lib/format";
import type { WorkflowListRow, WorkflowDetailResponse } from "@/lib/api-client";
import { toast } from "@/components/ui/sonner";

// ─── Styling maps ─────────────────────────────────────────────────────────────

const statusStyles: Record<string, string> = {
  active: "bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]",
  paused: "bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]",
  draft: "bg-muted text-muted-foreground",
  inactive: "bg-muted text-muted-foreground",
};

const statusLabel: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  inactive: "Inactive",
};

const triggerTypeLabel: Record<string, string> = {
  booking_created: "Booking Created",
  booking_completed: "Booking Completed",
  contact_created: "New Contact Added",
  stage_changed: "CRM Stage Changed",
  task_completed: "Task Completed",
  invoice_overdue: "Invoice Overdue",
  scheduled: "Scheduled",
};

const triggerOptions = [
  { label: "Booking Created", icon: Calendar, category: "Calendar" },
  { label: "Booking Completed", icon: CheckCircle2, category: "Calendar" },
  { label: "New Contact Added", icon: UserPlus, category: "CRM" },
  { label: "CRM Stage Changed", icon: Target, category: "CRM" },
  { label: "Task Completed", icon: ClipboardList, category: "Tasks" },
  { label: "Invoice Overdue", icon: Clock, category: "Finance" },
  { label: "Scheduled Time", icon: Repeat, category: "System" },
];

const actionOptions = [
  { label: "Create Task", icon: ClipboardList },
  { label: "Assign User", icon: UserPlus },
  { label: "Send Notification", icon: Bell },
  { label: "Update Status", icon: Settings2 },
  { label: "Schedule Follow-up", icon: Clock },
  { label: "Send Email", icon: Mail },
];

// ─── Workflow Detail Panel ────────────────────────────────────────────────────

function WorkflowDetailPanel({
  workflowId,
  onClose,
}: {
  workflowId: string;
  onClose: () => void;
}) {
  const { organizationId } = useOrg();
  const { data, isLoading, isError, refetch } = useWorkflowDetail(organizationId, workflowId);

  const runNow = useRunWorkflowNow(organizationId, workflowId);
  const runTest = useRunWorkflowTest(organizationId, workflowId);
  const retryJob = useRetryWorkflowJob(organizationId);

  const workflow = data?.workflow;
  const runs = data?.workflowRuns.items ?? [];
  const failedJobs = data?.relatedFailedJobs ?? [];

  const handleRunNow = async () => {
    try {
      await runNow.mutateAsync({
        event: {
          entityType: workflow?.triggerType ?? "manual",
          eventType: workflow?.triggerType ?? "manual",
        },
      });
      toast.success("Workflow triggered successfully");
      void refetch();
    } catch {
      toast.error("Failed to run workflow. Please try again.");
    }
  };

  const handleRunTest = async () => {
    try {
      await runTest.mutateAsync({
        dryRun: true,
        sampleEvent: {
          entityType: workflow?.triggerType ?? "manual",
          eventType: workflow?.triggerType ?? "manual",
        },
      });
      toast.success("Test run completed — check execution log");
      void refetch();
    } catch {
      toast.error("Test run failed. Please try again.");
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      await retryJob.mutateAsync(jobId);
      toast.success("Job queued for retry");
      void refetch();
    } catch {
      toast.error("Failed to retry job");
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-[420px] bg-card border-l border-border z-50 shadow-2xl shadow-black/30 animate-slide-in-right overflow-y-auto">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="space-y-2">
                <div className="h-4 bg-secondary/80 animate-pulse rounded w-2/3" />
                <div className="h-3 bg-secondary/80 animate-pulse rounded w-full" />
              </div>
            ) : workflow ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", statusStyles[workflow.status] ?? statusStyles.inactive)}>
                    {statusLabel[workflow.status] ?? workflow.status}
                  </span>
                </div>
                <h2 className="text-lg font-bold text-foreground">{workflow.name}</h2>
                {workflow.description && (
                  <p className="text-xs text-muted-foreground mt-1">{workflow.description}</p>
                )}
              </>
            ) : null}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {isError && (
          <ErrorBanner message="Failed to load workflow details." onRetry={() => refetch()} />
        )}

        {workflow && (
          <>
            {/* Company */}
            {workflow.company && (
              <div className="flex items-center gap-2">
                <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium px-2 py-0.5 rounded border bg-secondary text-foreground border-border">
                  {workflow.company.name}
                </span>
              </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Total Runs", value: data!.workflowRuns.pagination.total.toLocaleString() },
                { label: "Last Run", value: runs[0]?.createdAt ? relativeTime(runs[0].createdAt) : "Never" },
                { label: "Trigger", value: triggerTypeLabel[workflow.triggerType] ?? workflow.triggerType },
              ].map((s, i) => (
                <div key={i} className="bg-secondary rounded-lg p-3 text-center">
                  <p className="text-base font-bold text-foreground tabular-nums truncate">{s.value}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Failed Jobs */}
            {failedJobs.length > 0 && (
              <div className="bg-destructive/8 border border-destructive/20 rounded-xl p-4">
                <p className="text-xs font-semibold text-destructive mb-2">
                  {failedJobs.length} failed job{failedJobs.length > 1 ? "s" : ""}
                </p>
                <div className="space-y-2">
                  {failedJobs.slice(0, 5).map((job) => (
                    <div key={job.id} className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-muted-foreground truncate">{job.lastError ?? "Unknown error"}</p>
                        {job.failedAt && (
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5">{relativeTime(job.failedAt)}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleRetryJob(job.id)}
                        disabled={retryJob.isPending}
                        className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors shrink-0 disabled:opacity-50"
                      >
                        {retryJob.isPending ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : (
                          <RotateCcw className="w-2.5 h-2.5" />
                        )}
                        Retry
                      </button>
                    </div>
                  ))}
                  {failedJobs.length > 5 && (
                    <p className="text-[10px] text-muted-foreground">+{failedJobs.length - 5} more failed jobs</p>
                  )}
                </div>
              </div>
            )}

            {/* Execution Log */}
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Executions</h3>
              <div className="space-y-2">
                {runs.length === 0 ? (
                  <p className="text-xs text-muted-foreground bg-secondary rounded-lg p-3 text-center">No executions yet</p>
                ) : (
                  runs.slice(0, 5).map((run) => (
                    <div key={run.id} className="flex items-center gap-3 bg-secondary rounded-lg p-3">
                      <div className={cn(
                        "w-2 h-2 rounded-full shrink-0",
                        run.status === "completed" ? "bg-[hsl(var(--success))]" :
                        run.status === "failed" ? "bg-[hsl(var(--urgent))]" :
                        "bg-[hsl(var(--warning))]"
                      )} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-foreground">
                          {run.status === "completed" ? "All actions completed" :
                           run.status === "failed" ? (run.failureReason ?? "Failed") :
                           "Running"}
                        </p>
                        {run.triggerEvent && (
                          <p className="text-[10px] text-muted-foreground">{run.triggerEvent.label}</p>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(run.createdAt)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="pt-4 border-t border-border flex gap-3">
              <button
                onClick={handleRunNow}
                disabled={runNow.isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50"
              >
                {runNow.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Run Now
              </button>
              <button
                onClick={handleRunTest}
                disabled={runTest.isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-secondary text-foreground hover:bg-surface-3 transition-all disabled:opacity-50"
              >
                {runTest.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Test Run
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Automations Page ─────────────────────────────────────────────────────────

export default function AutomationsPage() {
  const { organizationId, companyId } = useOrg();
  const [search, setSearch] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [triggerFilter, setTriggerFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);

  const params = useMemo(() => ({
    companyId: companyId || undefined,
    search: search || undefined,
    status: statusFilter || undefined,
    triggerType: triggerFilter || undefined,
  }), [companyId, search, statusFilter, triggerFilter]);

  const { data: workflows, isLoading, isError, refetch } = useWorkflows(organizationId, params);
  const { data: impact } = useAutomationImpact(organizationId);
  const triggerWorkflow = useTriggerWorkflow(organizationId);
  const updateStatus = useUpdateWorkflowStatus(organizationId);

  const workflowList = workflows?.rows?.items ?? [];

  const handleQuickRun = async (id: string, triggerType: string) => {
    try {
      await triggerWorkflow.mutateAsync({
        workflowId: id,
        event: { entityType: triggerType, eventType: triggerType },
      });
      toast.success("Workflow triggered");
    } catch {
      toast.error("Failed to trigger workflow");
    }
  };

  const handleToggleStatus = async (id: string, current: string) => {
    const next = current === "active" ? "paused" : "active";
    try {
      await updateStatus.mutateAsync({ workflowId: id, status: next });
      toast.success(next === "active" ? "Workflow activated" : "Workflow paused");
    } catch {
      toast.error("Failed to update workflow");
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Automations</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Streamline your operations with smart workflows</p>
        </div>
        <button className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-violet))] text-white hover:bg-[hsl(var(--accent-violet))]/90 transition-all shadow-md shadow-violet-500/20 active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          Create Workflow
        </button>
      </div>

      {/* Impact Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: "Time Saved", value: formatSeconds(impact?.estimatedTimeSavedSeconds ?? 0), icon: Clock, color: "text-[hsl(var(--accent-blue))]" },
          { label: "Tasks Automated", value: (impact?.tasksAutoCreated ?? 0).toLocaleString(), icon: Zap, color: "text-[hsl(var(--accent-violet))]" },
          { label: "Success Rate", value: formatPercent(impact?.successRate ?? 0), icon: CheckCircle2, color: "text-[hsl(var(--success))]" },
          { label: "Active Workflows", value: workflowList.filter(w => w.status === "active").length.toString(), icon: Play, color: "text-primary" },
        ].map((stat, i) => (
          <div key={i} className="bg-card border border-border rounded-2xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <stat.icon className={cn("w-4 h-4", stat.color)} />
              <TrendingUp className="w-3 h-3 text-muted-foreground" />
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">{stat.value}</p>
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search workflows..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-card border border-border rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
        <div className="relative">
          <button
            onClick={() => setFilterOpen((v) => !v)}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-colors",
              statusFilter || triggerFilter ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground hover:text-foreground",
            )}
          >
            <Filter className="w-3.5 h-3.5" />
            Filter
            {(statusFilter || triggerFilter) && (
              <span className="ml-0.5 text-[10px] font-bold bg-primary text-primary-foreground rounded-full w-4 h-4 flex items-center justify-center">
                {(statusFilter ? 1 : 0) + (triggerFilter ? 1 : 0)}
              </span>
            )}
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
              <div className="absolute top-full right-0 mt-1 w-56 bg-popover border border-border rounded-lg shadow-xl z-50 p-3 space-y-3 animate-scale-in">
                <div>
                  <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Status</label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                  >
                    <option value="">All statuses</option>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="draft">Draft</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Trigger</label>
                  <select
                    value={triggerFilter}
                    onChange={(e) => setTriggerFilter(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                  >
                    <option value="">All triggers</option>
                    {Object.entries(triggerTypeLabel).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                {(statusFilter || triggerFilter) && (
                  <button
                    onClick={() => { setStatusFilter(""); setTriggerFilter(""); }}
                    className="w-full text-xs text-muted-foreground hover:text-foreground py-1"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Workflow Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : isError ? (
        <ErrorBanner message="Failed to load workflows." onRetry={refetch} />
      ) : workflowList.length === 0 ? (
        <EmptyState
          title="No workflows found"
          description={search ? "Try adjusting your search terms." : "Start automating your business today."}
          action={!search ? { label: "Create Workflow", onClick: () => {} } : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {workflowList.map((workflow) => (
            <div
              key={workflow.id}
              onClick={() => setSelectedWorkflowId(workflow.id)}
              className="bg-card border border-border rounded-2xl p-5 shadow-sm hover:shadow-md hover:border-primary/30 transition-all cursor-pointer group relative overflow-hidden"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <Zap className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn("text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full", statusStyles[workflow.status] ?? statusStyles.inactive)}>
                    {statusLabel[workflow.status] ?? workflow.status}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleStatus(workflow.id, workflow.status);
                    }}
                    disabled={updateStatus.isPending}
                    title={workflow.status === "active" ? "Pause workflow" : "Activate workflow"}
                    className="p-1.5 rounded-lg bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all disabled:opacity-50"
                  >
                    {workflow.status === "active" ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleQuickRun(workflow.id, workflow.triggerType);
                    }}
                    className="p-1.5 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 opacity-0 group-hover:opacity-100 transition-all"
                    title="Run now"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>
                </div>
              </div>

              <h3 className="text-sm font-bold text-foreground mb-1 group-hover:text-primary transition-colors">{workflow.name}</h3>
              <p className="text-xs text-muted-foreground line-clamp-2 mb-4 h-8">{workflow.description}</p>

              <div className="space-y-3 pt-4 border-t border-border/50">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground font-medium">Trigger</span>
                  <span className="text-foreground font-bold">{triggerTypeLabel[workflow.triggerType] ?? workflow.triggerType}</span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground font-medium">Last Run</span>
                  <span className="text-foreground font-bold">{workflow.recentRunSummary.lastRunAt ? relativeTime(workflow.recentRunSummary.lastRunAt) : "Never"}</span>
                </div>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground font-medium">Success Rate</span>
                  <span className="text-[hsl(var(--success))] font-bold">{formatPercent(workflow.metrics.successRate)}</span>
                </div>
              </div>

              {workflow.company && (
                <div className="mt-4 pt-3 border-t border-border/50 flex items-center gap-2">
                  <Building2 className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[10px] font-medium text-muted-foreground">{workflow.company.name}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Detail Panel */}
      {selectedWorkflowId && (
        <WorkflowDetailPanel
          workflowId={selectedWorkflowId}
          onClose={() => setSelectedWorkflowId(null)}
        />
      )}
    </div>
  );
}
