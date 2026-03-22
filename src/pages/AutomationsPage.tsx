import { useState } from "react";
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
  useRunWorkflowTest,
  useRetryWorkflowJob,
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

            {/* Primary Actions */}
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={handleRunNow}
                  disabled={runNow.isPending}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-50 disabled:cursor-wait"
                >
                  {runNow.isPending ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</>
                  ) : (
                    <><Play className="w-3.5 h-3.5" /> Run Now</>
                  )}
                </button>
                <button
                  onClick={handleRunTest}
                  disabled={runTest.isPending}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-50 disabled:cursor-wait"
                >
                  {runTest.isPending ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Testing…</>
                  ) : (
                    <><Eye className="w-3.5 h-3.5" /> Test Run</>
                  )}
                </button>
              </div>
              <div className="flex gap-2">
                {workflow.status === "active" ? (
                  <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning))]/25 transition-colors">
                    <Pause className="w-3.5 h-3.5" /> Pause
                  </button>
                ) : (
                  <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] hover:bg-[hsl(var(--success))]/25 transition-colors">
                    <Play className="w-3.5 h-3.5" /> Activate
                  </button>
                )}
                <button className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
                  <Settings2 className="w-3.5 h-3.5" /> Edit
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Workflow Builder Overlay ─────────────────────────────────────────────────

function WorkflowBuilderOverlay({
  trigger, actions, onSetTrigger, onToggleAction, onClose,
}: {
  trigger: string | null;
  actions: string[];
  onSetTrigger: (t: string) => void;
  onToggleAction: (a: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-[720px] max-h-[85vh] overflow-y-auto shadow-2xl shadow-black/40 animate-fade-in">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-foreground">Create Workflow</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Build an automation by selecting a trigger and actions</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Workflow Name</label>
            <input
              placeholder="e.g., New Booking Workflow"
              className="mt-1.5 w-full px-3 py-2.5 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {(trigger || actions.length > 0) && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">Flow Preview</label>
              <div className="bg-secondary rounded-xl p-4 flex items-center gap-2 flex-wrap">
                {trigger && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary border border-primary/20">
                    <Zap className="w-3 h-3" /> {trigger}
                  </div>
                )}
                {trigger && actions.length > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" />}
                {actions.map((a, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-card border border-border text-foreground">
                      <ArrowRight className="w-3 h-3" /> {a}
                    </div>
                    {i < actions.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" />}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold">1</div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Select Trigger</label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {triggerOptions.map((t) => (
                <button
                  key={t.label}
                  onClick={() => onSetTrigger(t.label)}
                  className={cn(
                    "flex items-center gap-2.5 p-3 rounded-xl text-left text-sm border transition-all active:scale-[0.98]",
                    trigger === t.label
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "bg-secondary border-border text-foreground hover:border-primary/20"
                  )}
                >
                  <t.icon className="w-4 h-4 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">{t.label}</p>
                    <p className="text-[10px] text-muted-foreground">{t.category}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold">2</div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Select Actions</label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {actionOptions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => onToggleAction(a.label)}
                  className={cn(
                    "flex items-center gap-2.5 p-3 rounded-xl text-left text-sm border transition-all active:scale-[0.98]",
                    actions.includes(a.label)
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "bg-secondary border-border text-foreground hover:border-primary/20"
                  )}
                >
                  <a.icon className="w-4 h-4 shrink-0" />
                  <p className="font-medium">{a.label}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-border flex items-center justify-between">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
          <div className="flex gap-2">
            <button className="px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
              Save as Draft
            </button>
            <button
              disabled={!trigger || actions.length === 0}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              Activate Workflow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Automations Page ─────────────────────────────────────────────────────────

const UI_STATUSES = ["All", "Active", "Paused", "Draft"] as const;
const uiStatusToApi: Record<string, string> = {
  Active: "active",
  Paused: "paused",
  Draft: "draft",
};

export default function AutomationsPage() {
  const { organizationId, companyId } = useOrg();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [builderTrigger, setBuilderTrigger] = useState<string | null>(null);
  const [builderActions, setBuilderActions] = useState<string[]>([]);

  const handleSearch = (value: string) => {
    setSearch(value);
    clearTimeout((handleSearch as any)._t);
    (handleSearch as any)._t = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const apiStatus = filterStatus !== "All" ? uiStatusToApi[filterStatus] : undefined;
  const apiCompanyId = companyId !== "all" ? companyId : undefined;

  const { data, isLoading, isError, refetch } = useWorkflows(organizationId, {
    search: debouncedSearch || undefined,
    status: apiStatus,
    companyId: apiCompanyId,
    pageSize: 50,
  });

  const { data: impactData } = useAutomationImpact(organizationId);

  const workflows = data?.rows.items ?? [];
  const totalCount = data?.rows.pagination.total ?? 0;

  const activeCount = workflows.filter((w) => w.status === "active").length;
  const totalRuns = workflows.reduce((s, w) => s + w.metrics.totalRuns, 0);
  const avgSuccessRate = workflows.filter((w) => w.metrics.totalRuns > 0).length > 0
    ? workflows.filter((w) => w.metrics.totalRuns > 0).reduce((s, w) => s + w.metrics.successRate, 0) /
      workflows.filter((w) => w.metrics.totalRuns > 0).length
    : 0;

  const statsStrip = [
    { label: "Active Workflows", value: isLoading ? "—" : String(activeCount), icon: Zap, color: "text-[hsl(var(--success))]" },
    { label: "Total Executions", value: isLoading ? "—" : totalRuns.toLocaleString(), icon: Repeat, color: "text-primary" },
    { label: "Avg Success Rate", value: isLoading ? "—" : formatPercent(avgSuccessRate), icon: TrendingUp, color: "text-[hsl(var(--success))]" },
    { label: "Tasks Created", value: impactData ? String(impactData.tasksAutoCreated) : "—", icon: ClipboardList, color: "text-[hsl(var(--warning))]" },
    { label: "Time Saved", value: impactData ? formatSeconds(impactData.estimatedTimeSavedSeconds) : "—", icon: Clock, color: "text-[hsl(var(--accent-blue,215_100%_55%))]" },
    { label: "Draft Workflows", value: isLoading ? "—" : String(workflows.filter((w) => w.status === "draft").length), icon: Settings2, color: "text-muted-foreground" },
  ];

  // Inline Run Now per card (without opening detail panel)
  const runNowForCard = (workflowId: string, triggerType: string) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const orgId = organizationId;
      // We need a local mutation instance per card — use fetch directly
      const res = await fetch(`/api/organizations/${orgId}/workflows/${workflowId}/run-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: { entityType: triggerType, eventType: triggerType } }),
      });
      if (!res.ok) throw new Error("Failed");
      toast.success("Workflow triggered");
      void refetch();
    } catch {
      toast.error("Failed to run workflow");
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Automations</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isLoading ? "Loading..." : `${activeCount} active workflows · ${totalRuns.toLocaleString()} total runs`}
          </p>
        </div>
        <button
          onClick={() => { setShowBuilder(true); setBuilderTrigger(null); setBuilderActions([]); }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" />
          Create Workflow
        </button>
      </div>

      {/* Error */}
      {isError && (
        <ErrorBanner message="Failed to load workflows." onRetry={() => refetch()} />
      )}

      {/* Impact & Stats strip */}
      <div className="grid grid-cols-6 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "60ms" }}>
        {statsStrip.map((stat, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
            <div className={cn("w-9 h-9 rounded-lg bg-secondary flex items-center justify-center", stat.color)}>
              <stat.icon className="w-4 h-4" />
            </div>
            <div>
              <p className="text-lg font-bold text-foreground tabular-nums">{stat.value}</p>
              <p className="text-xs text-muted-foreground">{stat.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search workflows…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex gap-1 bg-secondary rounded-lg p-0.5 border border-border">
          {UI_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                filterStatus === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Workflow list */}
      <div className="space-y-3 opacity-0 animate-fade-in" style={{ animationDelay: "180ms" }}>
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} rows={3} />
          ))
        ) : workflows.length === 0 ? (
          <EmptyState title="No workflows found" description="Try adjusting your filters or create a new workflow." />
        ) : (
          workflows.map((w) => (
            <div
              key={w.id}
              onClick={() => setSelectedWorkflowId(selectedWorkflowId === w.id ? null : w.id)}
              className={cn(
                "bg-card border rounded-xl p-5 hover:shadow-lg hover:shadow-black/10 transition-all duration-200 cursor-pointer group",
                selectedWorkflowId === w.id ? "border-primary/40 shadow-lg shadow-primary/5" : "border-border"
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* Top row */}
                  <div className="flex items-center gap-2.5 mb-2">
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                      w.status === "active" ? "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]" :
                      w.status === "paused" ? "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]" :
                      "bg-muted text-muted-foreground"
                    )}>
                      <Zap className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-foreground truncate">{w.name}</p>
                        <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded", statusStyles[w.status] ?? statusStyles.inactive)}>
                          {statusLabel[w.status] ?? w.status}
                        </span>
                        {w.recentRunSummary.failedCount > 0 && (
                          <span className="flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">
                            <AlertTriangle className="w-2.5 h-2.5" />
                            {w.recentRunSummary.failedCount} failed
                          </span>
                        )}
                      </div>
                      {w.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{w.description}</p>
                      )}
                    </div>
                  </div>

                  {/* Trigger type pill */}
                  <div className="flex items-center gap-1.5 ml-10 mt-3 flex-wrap">
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border bg-primary/10 text-primary border-primary/20">
                      <Zap className="w-3.5 h-3.5" />
                      <span>{triggerTypeLabel[w.triggerType] ?? w.triggerType}</span>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border bg-secondary text-secondary-foreground border-border">
                      <ClipboardList className="w-3.5 h-3.5" />
                      <span>Actions</span>
                    </div>
                  </div>
                </div>

                {/* Right meta */}
                <div className="flex items-center gap-5 shrink-0 pt-1">
                  {w.company && (
                    <div className="text-[11px] font-medium px-2 py-0.5 rounded border bg-secondary text-foreground border-border">
                      {w.company.name}
                    </div>
                  )}
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground tabular-nums">{w.metrics.totalRuns.toLocaleString()}</p>
                    <p className="text-[10px] text-muted-foreground">runs</p>
                  </div>
                  {w.metrics.totalRuns > 0 && (
                    <div className="text-right">
                      <p className="text-sm font-semibold text-foreground tabular-nums">{formatPercent(w.metrics.successRate, 1)}</p>
                      <p className="text-[10px] text-muted-foreground">success</p>
                    </div>
                  )}
                  <div className="text-right min-w-[70px]">
                    <p className="text-xs text-muted-foreground">
                      {w.recentRunSummary.lastRunAt ? relativeTime(w.recentRunSummary.lastRunAt) : "Never"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={runNowForCard(w.id, w.triggerType)}
                      className="p-1.5 rounded-lg hover:bg-primary/10 transition-colors text-primary opacity-0 group-hover:opacity-100"
                      title="Run Now"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground opacity-0 group-hover:opacity-100"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Workflow Detail Panel */}
      {selectedWorkflowId && (
        <WorkflowDetailPanel workflowId={selectedWorkflowId} onClose={() => setSelectedWorkflowId(null)} />
      )}

      {/* Workflow Builder Overlay */}
      {showBuilder && (
        <WorkflowBuilderOverlay
          trigger={builderTrigger}
          actions={builderActions}
          onSetTrigger={setBuilderTrigger}
          onToggleAction={(a) => setBuilderActions(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a])}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  );
}
