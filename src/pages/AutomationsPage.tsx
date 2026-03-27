import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search, Workflow, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/system/AsyncState";
import { useAppContext } from "@/lib/app-context";
import { apiRequest, toQueryString } from "@/lib/api";
import { formatDateTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface WorkflowsListResponse {
  rows: {
    items: Array<{
      company: { id: string; name: string } | null;
      createdAt: string;
      description: string | null;
      id: string;
      metrics: {
        failedRuns: number;
        successRate: number;
        totalRuns: number;
      };
      name: string;
      recentRunSummary: {
        lastRunAt: string | null;
        lastRunStatus: string | null;
        recentRunsCount: number;
      };
      status: string;
      triggerType: string;
    }>;
  };
}

interface AutomationImpactResponse {
  estimatedTimeSavedSeconds: number;
  failedJobsCount: number;
  successRate: number;
  tasksAutoCreated: number;
  totalWorkflowRuns: number;
}

interface WorkflowJobsResponse {
  rows: {
    items: Array<{
      activityEvent: { id: string; label: string } | null;
      activityEventId: string;
      attemptCount: number;
      availableAt: string;
      claimedAt: string | null;
      company: { id: string; name: string } | null;
      failureReason: string | null;
      id: string;
      lastError: string | null;
      remainingAttempts: number;
      retryEligible: boolean;
      status: string;
      updatedAt: string;
      workerId: string | null;
    }>;
  };
  summary: {
    completedRecentCount: number;
    failedCount: number;
    pendingCount: number;
    runningCount: number;
    suspiciousRunningCount: number;
  };
}

interface WorkflowDetailResponse {
  relatedFailedJobs: Array<{
    activityEvent: { id: string; label: string } | null;
    failedAt: string | null;
    id: string;
    lastError: string | null;
    retryEligible: boolean;
    status: string;
  }>;
  workflow: {
    company: { id: string; name: string } | null;
    createdAt: string;
    description: string | null;
    id: string;
    name: string;
    status: string;
    triggerType: string;
  };
  workflowRuns: {
    items: Array<{
      completedAt: string | null;
      createdAt: string;
      failureReason: string | null;
      id: string;
      status: string;
      triggerEvent: { id: string; label: string } | null;
    }>;
  };
}

interface WorkflowExecutionResponse {
  actionsExecutedCount: number;
  createdTasksCount: number;
  dryRun: boolean;
  failureReason: string | null;
  matchedConditions: boolean;
  skippedReason: string | null;
  timeSavedSeconds: number;
}

function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDefaultWorkflowEvent(triggerType: string, companyId: string | null): string {
  const base = {
    companyId,
    entityId: null,
    metadata: {},
    relatedEntityId: null,
    relatedEntityType: null,
  } as const;

  switch (triggerType) {
    case "contact.created":
      return JSON.stringify({
        ...base,
        entityType: "contact",
        eventType: triggerType,
      }, null, 2);
    case "contact.stage_changed":
      return JSON.stringify({
        ...base,
        entityType: "contact",
        eventType: triggerType,
        metadata: {
          previousStage: "lead",
          stage: "qualified",
          stage_changed_to: "qualified",
        },
      }, null, 2);
    case "booking.created":
    case "booking.completed":
      return JSON.stringify({
        ...base,
        entityType: "booking",
        eventType: triggerType,
      }, null, 2);
    case "task.completed":
      return JSON.stringify({
        ...base,
        entityType: "task",
        eventType: triggerType,
      }, null, 2);
    default:
      return JSON.stringify({
        ...base,
        entityType: "contact",
        eventType: triggerType,
      }, null, 2);
  }
}

export default function AutomationsPage() {
  const queryClient = useQueryClient();
  const { activeCompanyId, activeOrganizationId } = useAppContext();
  const [search, setSearch] = useState("");
  const [jobStatusFilter, setJobStatusFilter] = useState<"all" | "pending" | "running" | "completed" | "failed">("all");
  const [recentFailuresOnly, setRecentFailuresOnly] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowEventJson, setWorkflowEventJson] = useState("");
  const [workflowRunMessage, setWorkflowRunMessage] = useState<string | null>(null);

  const workflowsQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "automations", activeCompanyId ?? "all", search],
    queryFn: () =>
      apiRequest<WorkflowsListResponse>(
        `/api/organizations/${activeOrganizationId}/ui/automations/workflows${toQueryString({
          companyId: activeCompanyId,
          limit: 100,
          page: 1,
          search,
        })}`,
      ),
  });
  const automationImpactQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "dashboard", "automation-impact", activeCompanyId ?? "all"],
    queryFn: () =>
      apiRequest<AutomationImpactResponse>(
        `/api/organizations/${activeOrganizationId}/ui/dashboard/automation-impact${toQueryString({
          companyId: activeCompanyId,
        })}`,
      ),
  });
  const jobsQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "automations", "jobs", activeCompanyId ?? "all", jobStatusFilter, recentFailuresOnly],
    queryFn: () =>
      apiRequest<WorkflowJobsResponse>(
        `/api/organizations/${activeOrganizationId}/ui/automations/jobs${toQueryString({
          companyId: activeCompanyId,
          limit: 20,
          page: 1,
          recentFailures: recentFailuresOnly || undefined,
          status: jobStatusFilter === "all" ? undefined : jobStatusFilter,
        })}`,
      ),
  });
  const workflowDetailQuery = useQuery({
    enabled: Boolean(selectedWorkflowId),
    queryKey: ["org", activeOrganizationId, "automations", "detail", selectedWorkflowId, activeCompanyId ?? "all"],
    queryFn: () =>
      apiRequest<WorkflowDetailResponse>(
        `/api/organizations/${activeOrganizationId}/ui/automations/workflows/${selectedWorkflowId}${toQueryString({
          companyId: activeCompanyId,
        })}`,
      ),
  });
  const retryJobMutation = useMutation({
    mutationFn: (jobId: string) => apiRequest(`/api/organizations/${activeOrganizationId}/workflow-event-jobs/${jobId}/retry`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "automations"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "dashboard"] }),
      ]);
    },
  });
  const runWorkflowTestMutation = useMutation({
    mutationFn: (sampleEvent: Record<string, unknown>) =>
      apiRequest<WorkflowExecutionResponse>(`/api/organizations/${activeOrganizationId}/workflows/${selectedWorkflowId}/run-test`, {
        body: JSON.stringify({ dryRun: true, sampleEvent }),
        method: "POST",
      }),
    onSuccess: (data) => {
      setWorkflowRunMessage(
        data.failureReason
          ? `Test run failed: ${data.failureReason}`
          : `Test run complete. ${data.actionsExecutedCount} actions projected and ${data.createdTasksCount} tasks projected.`,
      );
    },
  });
  const runWorkflowNowMutation = useMutation({
    mutationFn: (event: Record<string, unknown>) =>
      apiRequest<WorkflowExecutionResponse>(`/api/organizations/${activeOrganizationId}/workflows/${selectedWorkflowId}/run-now`, {
        body: JSON.stringify({ event }),
        method: "POST",
      }),
    onSuccess: async (data) => {
      setWorkflowRunMessage(
        data.failureReason
          ? `Run now failed: ${data.failureReason}`
          : `Workflow executed. ${data.actionsExecutedCount} actions ran and ${data.createdTasksCount} tasks were created.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "automations"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "tasks"] }),
      ]);
    },
  });

  useEffect(() => {
    setSelectedWorkflowId(null);
    setJobStatusFilter("all");
    setRecentFailuresOnly(false);
    setWorkflowEventJson("");
    setWorkflowRunMessage(null);
  }, [activeCompanyId, activeOrganizationId]);

  useEffect(() => {
    const workflowsList = workflowsQuery.data?.rows?.items ?? [];
    const workflow = workflowsList.find((w) => w.id === selectedWorkflowId) ?? null;
    if (!workflow) {
      setWorkflowEventJson("");
      setWorkflowRunMessage(null);
      return;
    }

    setWorkflowEventJson(
      buildDefaultWorkflowEvent(
        workflow.triggerType,
        activeCompanyId ?? workflow.company?.id ?? null,
      ),
    );
    setWorkflowRunMessage(null);
  }, [activeCompanyId, selectedWorkflowId, workflowsQuery.data]);

  if (workflowsQuery.isLoading) {
    return <LoadingState label="Loading workflow automation data..." />;
  }

  if (workflowsQuery.error) {
    return (
      <ErrorState
        description={workflowsQuery.error instanceof Error ? workflowsQuery.error.message : "Unable to load workflows."}
        onRetry={() => workflowsQuery.refetch()}
        title="Automations unavailable"
      />
    );
  }

  const workflows = workflowsQuery.data.rows.items;
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null;

  const executeWorkflowControl = (mode: "run" | "test") => {
    try {
      const parsed = JSON.parse(workflowEventJson) as Record<string, unknown>;

      if (mode === "test") {
        runWorkflowTestMutation.mutate(parsed);
        return;
      }

      runWorkflowNowMutation.mutate(parsed);
    } catch {
      setWorkflowRunMessage("Workflow event JSON is invalid.");
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Automations</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Workflow observability and queue health for internal operations</p>
        </div>
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground outline-none"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search workflows..."
            value={search}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Visible Workflows</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{workflows.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Queue Pending</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{jobsQuery.data?.summary.pendingCount ?? 0}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Queue Running</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{jobsQuery.data?.summary.runningCount ?? 0}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Queue Failed</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{jobsQuery.data?.summary.failedCount ?? 0}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Completed (24h)</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{jobsQuery.data?.summary.completedRecentCount ?? 0}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Stale Running</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{jobsQuery.data?.summary.suspiciousRunningCount ?? 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <Workflow className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Workflow List</h2>
          </div>
          {workflows.length === 0 ? (
            <EmptyState description="No workflows match the current organization/company scope." title="No workflows found" />
          ) : (
            <div className="space-y-3">
              {workflows.map((workflow) => (
                <button
                  key={workflow.id}
                  className={cn(
                    "w-full rounded-lg border px-4 py-3 text-left transition-colors",
                    workflow.id === selectedWorkflowId ? "border-primary/50 bg-primary/5" : "border-border/60 bg-background/30",
                  )}
                  onClick={() => setSelectedWorkflowId(workflow.id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{workflow.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {workflow.company?.name ?? "Global"} - {labelize(workflow.status)} - Trigger {workflow.triggerType}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">{workflow.metrics.totalRuns} runs</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{workflow.description ?? "No workflow description provided."}</p>
                  <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                    <span>{workflow.metrics.successRate}% success</span>
                    <span>{workflow.metrics.failedRuns} failed runs</span>
                    <span>{workflow.recentRunSummary.lastRunAt ? formatDateTime(workflow.recentRunSummary.lastRunAt) : "Never run"}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="space-y-3 rounded-lg border border-border/60 bg-background/30 p-4">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Automation Impact</h3>
            </div>
            {automationImpactQuery.isLoading ? <LoadingState label="Loading impact metrics..." /> : null}
            {automationImpactQuery.error ? (
              <ErrorState
                description={automationImpactQuery.error instanceof Error ? automationImpactQuery.error.message : "Unable to load automation impact."}
                onRetry={() => automationImpactQuery.refetch()}
                title="Impact unavailable"
              />
            ) : null}
            {automationImpactQuery.data ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Workflow Runs</p>
                  <p className="text-lg font-semibold text-foreground">{automationImpactQuery.data.totalWorkflowRuns}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Success Rate</p>
                  <p className="text-lg font-semibold text-foreground">{automationImpactQuery.data.successRate}%</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Tasks Auto-Created</p>
                  <p className="text-lg font-semibold text-foreground">{automationImpactQuery.data.tasksAutoCreated}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Failed Jobs</p>
                  <p className="text-lg font-semibold text-foreground">{automationImpactQuery.data.failedJobsCount}</p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 bg-background/30 p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Queue Jobs</h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(["all", "pending", "running", "completed", "failed"] as const).map((status) => (
                <button
                  key={status}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs transition-colors",
                    jobStatusFilter === status ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground",
                  )}
                  onClick={() => setJobStatusFilter(status)}
                >
                  {labelize(status)}
                </button>
              ))}
              <button
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs transition-colors",
                  recentFailuresOnly ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-card text-muted-foreground",
                )}
                onClick={() => setRecentFailuresOnly((current) => !current)}
              >
                Recent failures
              </button>
            </div>
            {jobsQuery.isLoading ? <LoadingState label="Loading workflow jobs..." /> : null}
            {jobsQuery.error ? (
              <ErrorState
                description={jobsQuery.error instanceof Error ? jobsQuery.error.message : "Unable to load workflow jobs."}
                onRetry={() => jobsQuery.refetch()}
                title="Workflow jobs unavailable"
              />
            ) : null}
            {jobsQuery.data && jobsQuery.data.rows.items.length === 0 ? (
              <EmptyState description="No workflow event jobs were found in the current scope." title="No queue jobs" />
            ) : null}
            {jobsQuery.data ? (
              <div className="space-y-2">
                {jobsQuery.data.rows.items.map((job) => (
                  <div key={job.id} className="rounded-lg border border-border/60 bg-card/70 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">{job.activityEvent?.label ?? "Workflow event job"}</p>
                        <p className="text-xs text-muted-foreground">
                          {job.company?.name ?? "No company"} - {labelize(job.status)} - Attempt {job.attemptCount}
                        </p>
                      </div>
                      {job.retryEligible ? (
                        <Button
                          disabled={retryJobMutation.isPending}
                          onClick={() => retryJobMutation.mutate(job.id)}
                          size="sm"
                          variant="outline"
                        >
                          Retry
                        </Button>
                      ) : null}
                    </div>
                    {job.workerId || job.claimedAt ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {job.workerId ? `Worker ${job.workerId}` : "Claimed"}
                        {job.claimedAt ? ` - ${formatDateTime(job.claimedAt)}` : ""}
                      </p>
                    ) : null}
                    <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-muted-foreground">
                      <p>Job ID: {job.id}</p>
                      <p>Activity Event ID: {job.activityEventId}</p>
                      <p>Available At: {formatDateTime(job.availableAt)}</p>
                      <p>Updated At: {formatDateTime(job.updatedAt)}</p>
                      <p>Remaining Attempts: {job.remainingAttempts}</p>
                    </div>
                    {job.failureReason ? <p className="mt-2 text-sm text-destructive">{job.failureReason}</p> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <aside className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Workflow Detail</h2>
          {!selectedWorkflow ? (
            <EmptyState description="Select a workflow from the list to inspect runs and linked failed jobs." title="No workflow selected" />
          ) : null}
          {selectedWorkflow && workflowDetailQuery.isLoading ? <LoadingState label="Loading workflow detail..." /> : null}
          {selectedWorkflow && workflowDetailQuery.error ? (
            <ErrorState
              description={workflowDetailQuery.error instanceof Error ? workflowDetailQuery.error.message : "Unable to load workflow detail."}
              onRetry={() => workflowDetailQuery.refetch()}
              title="Workflow detail unavailable"
            />
          ) : null}
          {workflowDetailQuery.data ? (
            <div className="space-y-4">
              <div>
                <p className="text-lg font-semibold text-foreground">{workflowDetailQuery.data.workflow.name}</p>
                <p className="text-sm text-muted-foreground">
                  {workflowDetailQuery.data.workflow.company?.name ?? "Global"} - {labelize(workflowDetailQuery.data.workflow.status)}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">{workflowDetailQuery.data.workflow.description ?? "No workflow description provided."}</p>
              </div>

              <div className="space-y-2 rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Run Controls</p>
                <textarea
                  className="min-h-[180px] w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground outline-none"
                  onChange={(event) => setWorkflowEventJson(event.target.value)}
                  value={workflowEventJson}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={runWorkflowNowMutation.isPending || runWorkflowTestMutation.isPending || !workflowEventJson.trim()}
                    onClick={() => executeWorkflowControl("test")}
                    size="sm"
                    variant="outline"
                  >
                    Test Run
                  </Button>
                  <Button
                    disabled={runWorkflowNowMutation.isPending || runWorkflowTestMutation.isPending || !workflowEventJson.trim()}
                    onClick={() => executeWorkflowControl("run")}
                    size="sm"
                  >
                    Run Now
                  </Button>
                </div>
                {workflowRunMessage ? <p className="text-xs text-muted-foreground">{workflowRunMessage}</p> : null}
                {runWorkflowTestMutation.error ? (
                  <p className="text-sm text-destructive">
                    {runWorkflowTestMutation.error instanceof Error ? runWorkflowTestMutation.error.message : "Unable to test the workflow."}
                  </p>
                ) : null}
                {runWorkflowNowMutation.error ? (
                  <p className="text-sm text-destructive">
                    {runWorkflowNowMutation.error instanceof Error ? runWorkflowNowMutation.error.message : "Unable to run the workflow now."}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Recent Runs</p>
                {workflowDetailQuery.data.workflowRuns.items.length === 0 ? (
                  <EmptyState description="This workflow has not produced any runs yet." title="No workflow runs" />
                ) : (
                  workflowDetailQuery.data.workflowRuns.items.map((run) => (
                    <div key={run.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                      <p className="text-sm font-medium text-foreground">{labelize(run.status)}</p>
                      <p className="text-xs text-muted-foreground">
                        {run.triggerEvent?.label ?? "Manual or synthetic event"} - {formatDateTime(run.createdAt)}
                      </p>
                      {run.failureReason ? <p className="mt-2 text-sm text-destructive">{run.failureReason}</p> : null}
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Related Failed Jobs</p>
                {workflowDetailQuery.data.relatedFailedJobs.length === 0 ? (
                  <EmptyState description="No failed jobs are currently linked to this workflow." title="No failed jobs" />
                ) : (
                  workflowDetailQuery.data.relatedFailedJobs.map((job) => (
                    <div key={job.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                      <p className="text-sm font-medium text-foreground">{job.activityEvent?.label ?? "Workflow event"}</p>
                      <p className="text-xs text-muted-foreground">{job.failedAt ? formatDateTime(job.failedAt) : "Failure time unknown"}</p>
                      {job.lastError ? <p className="mt-2 text-sm text-destructive">{job.lastError}</p> : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
