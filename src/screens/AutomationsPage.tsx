import { useState, useMemo, useRef } from "react";
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
  useCreateWorkflow,
  useUpdateWorkflow,
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

interface TestConditionResult {
  actualValue: unknown;
  condition: { field: string; operator: string; value?: unknown };
  matched: boolean;
}

interface TestProjectionAction {
  action: { type: string; [key: string]: unknown };
  resolvedPayload: Record<string, unknown>;
}

interface TestRunResult {
  matchedConditions: boolean;
  conditionResults: TestConditionResult[];
  projectedActions: TestProjectionAction[];
  actionsExecutedCount: number;
  createdTasksCount: number;
  skippedReason: string | null;
  failureReason: string | null;
  dryRun: boolean;
}

function describeTestCondition(c: TestConditionResult): string {
  const raw = c.condition.value;
  const valStr = Array.isArray(raw) ? raw.join(", ") : raw == null ? "" : String(raw);
  return `${c.condition.field} ${c.condition.operator}${valStr ? ` ${valStr}` : ""}`;
}

function describeTestAction(p: TestProjectionAction): string {
  const payload = p.resolvedPayload ?? {};
  switch (p.action.type) {
    case "create_task":
      return `Create task: ${(payload.title as string) || "(untitled)"}${payload.priority ? ` · ${String(payload.priority)}` : ""}`;
    case "update_status":
      return `Set status → ${payload.status ? String(payload.status) : "?"}`;
    case "assign_user":
      return "Assign a user";
    case "create_activity_event":
      return `Log activity: ${payload.event_type ? String(payload.event_type) : "event"}`;
    default:
      return p.action.type;
  }
}

function formatActualValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function WorkflowDetailPanel({
  workflowId,
  onClose,
  onEdit,
}: {
  workflowId: string;
  onClose: () => void;
  onEdit: (workflow: EditWorkflow) => void;
}) {
  const { organizationId } = useOrg();
  const { data, isLoading, isError, refetch } = useWorkflowDetail(organizationId, workflowId);

  const runNow = useRunWorkflowNow(organizationId, workflowId);
  const runTest = useRunWorkflowTest(organizationId, workflowId);
  const retryJob = useRetryWorkflowJob(organizationId);

  const [testOpen, setTestOpen] = useState(false);
  const [sampleStage, setSampleStage] = useState("");
  const [samplePriority, setSamplePriority] = useState("");
  const [sampleStatus, setSampleStatus] = useState("");
  const [sampleValue, setSampleValue] = useState("");
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);

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
    const trigger = workflow?.triggerType ?? "";
    // trigger is dot-separated (e.g. "contact.created") -> entity is the prefix.
    const entityType = trigger.split(".")[0] || "contact";
    const metadata: Record<string, unknown> = {};
    if (sampleStage.trim()) {
      metadata.stage = sampleStage.trim();
      metadata.stage_changed_to = sampleStage.trim();
    }
    if (samplePriority.trim()) metadata.priority = samplePriority.trim();
    if (sampleStatus.trim()) metadata.status = sampleStatus.trim();
    if (sampleValue.trim() && Number.isFinite(Number(sampleValue))) {
      metadata.value_cents = Number(sampleValue);
    }
    try {
      const payload = (await runTest.mutateAsync({
        dryRun: true,
        sampleEvent: { entityType, eventType: trigger, metadata },
      })) as { data: TestRunResult };
      setTestResult(payload.data);
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
          <div className="flex items-center gap-1 shrink-0">
            {workflow && (
              <button
                type="button"
                onClick={() =>
                  onEdit({
                    id: workflow.id,
                    name: workflow.name,
                    triggerType: workflow.triggerType,
                    description: workflow.description,
                    definition: workflow.definition,
                  })
                }
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <Settings2 className="w-3.5 h-3.5" /> Edit
              </button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
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
            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex gap-3">
                <button
                  onClick={handleRunNow}
                  disabled={runNow.isPending}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50"
                >
                  {runNow.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Run Now
                </button>
                <button
                  onClick={() => setTestOpen((v) => !v)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all",
                    testOpen ? "bg-surface-3 text-foreground" : "bg-secondary text-foreground hover:bg-surface-3"
                  )}
                >
                  <Zap className="w-4 h-4" />
                  Test Run
                </button>
              </div>

              {testOpen && (
                <div className="rounded-xl border border-border bg-secondary/40 p-4 space-y-3">
                  <p className="text-xs font-semibold text-foreground">Dry run — nothing is saved</p>
                  <p className="text-[11px] text-muted-foreground -mt-1.5">Optionally set sample values to test your conditions.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={sampleStage} onChange={(e) => setSampleStage(e.target.value)} placeholder="stage (e.g. lead)" className="w-full px-2.5 py-1.5 text-xs bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                    <input value={samplePriority} onChange={(e) => setSamplePriority(e.target.value)} placeholder="priority (e.g. high)" className="w-full px-2.5 py-1.5 text-xs bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                    <input value={sampleStatus} onChange={(e) => setSampleStatus(e.target.value)} placeholder="status" className="w-full px-2.5 py-1.5 text-xs bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                    <input value={sampleValue} onChange={(e) => setSampleValue(e.target.value)} type="number" placeholder="deal value (cents)" className="w-full px-2.5 py-1.5 text-xs bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                  <button
                    onClick={handleRunTest}
                    disabled={runTest.isPending}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--accent-violet))] text-white hover:bg-[hsl(var(--accent-violet))]/90 transition-colors disabled:opacity-50"
                  >
                    {runTest.isPending ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</> : <><Zap className="w-3.5 h-3.5" /> Run test</>}
                  </button>

                  {testResult && (
                    <div className="space-y-3 pt-1">
                      {testResult.failureReason ? (
                        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-2.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                          <p className="text-xs text-destructive">{testResult.failureReason}</p>
                        </div>
                      ) : testResult.matchedConditions ? (
                        <div className="flex items-start gap-2 rounded-lg bg-[hsl(var(--success))]/10 border border-[hsl(var(--success))]/20 p-2.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--success))] shrink-0 mt-0.5" />
                          <p className="text-xs text-foreground">
                            Conditions matched — would run <span className="font-semibold">{testResult.actionsExecutedCount}</span> action{testResult.actionsExecutedCount === 1 ? "" : "s"}
                            {testResult.createdTasksCount > 0 ? <>, create <span className="font-semibold">{testResult.createdTasksCount}</span> task{testResult.createdTasksCount === 1 ? "" : "s"}</> : null}
                          </p>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 rounded-lg bg-[hsl(var(--warning))]/10 border border-[hsl(var(--warning))]/20 p-2.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-[hsl(var(--warning))] shrink-0 mt-0.5" />
                          <p className="text-xs text-foreground">Conditions did not match — no actions would run.</p>
                        </div>
                      )}

                      {testResult.conditionResults.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Conditions</p>
                          <div className="space-y-1">
                            {testResult.conditionResults.map((c, i) => (
                              <div key={i} className="flex items-center justify-between gap-2 text-[11px] bg-card rounded-md px-2 py-1.5">
                                <span className="text-foreground truncate">{describeTestCondition(c)}</span>
                                <span className={cn("shrink-0 flex items-center gap-1", c.matched ? "text-[hsl(var(--success))]" : "text-muted-foreground")}>
                                  <span className="text-muted-foreground">got {formatActualValue(c.actualValue)}</span>
                                  {c.matched ? <CheckCircle2 className="w-3 h-3" /> : <X className="w-3 h-3" />}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {testResult.projectedActions.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Would run</p>
                          <div className="space-y-1">
                            {testResult.projectedActions.map((a, i) => (
                              <div key={i} className="flex items-center gap-2 text-[11px] text-foreground bg-card rounded-md px-2 py-1.5">
                                <ArrowRight className="w-3 h-3 text-[hsl(var(--accent-violet))] shrink-0" />
                                <span className="truncate">{describeTestAction(a)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Automations Page ─────────────────────────────────────────────────────────

// ─── Create Workflow Dialog ───────────────────────────────────────────────────

const WORKFLOW_TRIGGERS = [
  { value: "contact.created", label: "New contact added" },
  { value: "contact.stage_changed", label: "CRM stage changed" },
  { value: "booking.created", label: "Booking created" },
  { value: "booking.completed", label: "Booking completed" },
  { value: "task.completed", label: "Task completed" },
];

// Which entity each trigger fires on — drives the update_status options.
const TRIGGER_ENTITY: Record<string, "contact" | "booking" | "task"> = {
  "contact.created": "contact",
  "contact.stage_changed": "contact",
  "booking.created": "booking",
  "booking.completed": "booking",
  "task.completed": "task",
};

const ENTITY_STATUS_OPTIONS: Record<"contact" | "booking" | "task", { value: string; label: string }[]> = {
  contact: [
    { value: "lead", label: "Lead" },
    { value: "qualified", label: "Qualified" },
    { value: "active", label: "Active" },
    { value: "closed", label: "Closed" },
  ],
  booking: [
    { value: "pending", label: "Pending" },
    { value: "confirmed", label: "Confirmed" },
    { value: "completed", label: "Completed" },
    { value: "cancelled", label: "Cancelled" },
  ],
  task: [
    { value: "todo", label: "To Do" },
    { value: "in_progress", label: "In Progress" },
    { value: "blocked", label: "Blocked" },
    { value: "completed", label: "Completed" },
  ],
};

const ENTITY_STATUS_NOUN: Record<"contact" | "booking" | "task", string> = {
  contact: "stage",
  booking: "status",
  task: "status",
};

const CONDITION_FIELDS = [
  { value: "stage", label: "Contact stage" },
  { value: "stage_changed_to", label: "Changed to stage" },
  { value: "previous_stage", label: "Previous stage" },
  { value: "priority", label: "Priority" },
  { value: "status", label: "Status" },
  { value: "value_cents", label: "Deal value (cents)" },
  { value: "title", label: "Title" },
];

const CONDITION_OPERATORS = [
  { value: "equals", label: "equals" },
  { value: "in", label: "is any of" },
  { value: "changed_to", label: "changed to" },
  { value: "greater_than", label: "greater than" },
  { value: "less_than", label: "less than" },
  { value: "exists", label: "exists" },
] as const;

type ConditionOperator = (typeof CONDITION_OPERATORS)[number]["value"];

interface UICondition {
  id: string;
  field: string;
  operator: ConditionOperator;
  value: string;
}

interface UIAction {
  id: string;
  type: "create_task" | "update_status";
  // create_task
  title: string;
  priority: "low" | "medium" | "high" | "urgent";
  taskStatus: "todo" | "in_progress" | "blocked" | "completed";
  description: string;
  dueInDays: string;
  // update_status
  statusValue: string;
}

function newAction(type: UIAction["type"], id: string, statusValue: string): UIAction {
  return {
    id,
    type,
    title: "",
    priority: "medium",
    taskStatus: "todo",
    description: "",
    dueInDays: "",
    statusValue,
  };
}

interface EditWorkflow {
  id: string;
  name: string;
  triggerType: string;
  description: string | null;
  definition: unknown;
}

function definitionRecord(def: unknown): Record<string, unknown> {
  return def && typeof def === "object" && !Array.isArray(def) ? (def as Record<string, unknown>) : {};
}

function parseDefConditions(def: unknown): UICondition[] {
  const raw = definitionRecord(def).conditions;
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => {
    const cond = (c ?? {}) as Record<string, unknown>;
    const v = cond.value;
    return {
      id: `c-${i}`,
      field: typeof cond.field === "string" ? cond.field : "stage",
      operator: (typeof cond.operator === "string" ? cond.operator : "equals") as ConditionOperator,
      value: Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v),
    };
  });
}

function parseDefActions(def: unknown): UIAction[] {
  const raw = definitionRecord(def).actions;
  if (!Array.isArray(raw) || raw.length === 0) return [newAction("create_task", "a-0", "lead")];
  return raw.map((a, i) => {
    const act = (a ?? {}) as Record<string, unknown>;
    if (act.type === "update_status") {
      return newAction("update_status", `a-${i}`, typeof act.status === "string" ? act.status : "lead");
    }
    const base = newAction("create_task", `a-${i}`, "lead");
    const priority = ["low", "medium", "high", "urgent"].includes(act.priority as string)
      ? (act.priority as UIAction["priority"])
      : "medium";
    const taskStatus = ["todo", "in_progress", "blocked", "completed"].includes(act.status as string)
      ? (act.status as UIAction["taskStatus"])
      : "todo";
    return {
      ...base,
      title: typeof act.title === "string" ? act.title : "",
      priority,
      taskStatus,
      description: typeof act.description === "string" ? act.description : "",
      dueInDays: act.due_in_days != null ? String(act.due_in_days) : "",
    };
  });
}

function CreateWorkflowDialog({ orgId, workflow, onClose }: { orgId: string; workflow?: EditWorkflow; onClose: () => void }) {
  const createWorkflow = useCreateWorkflow(orgId);
  const updateWorkflow = useUpdateWorkflow(orgId);
  const editing = Boolean(workflow);
  const pending = editing ? updateWorkflow.isPending : createWorkflow.isPending;
  const idRef = useRef(1);
  const nextId = () => `row-${idRef.current++}`;

  const [name, setName] = useState(workflow?.name ?? "");
  const [triggerEvent, setTriggerEvent] = useState(workflow?.triggerType ?? "contact.created");
  const [conditions, setConditions] = useState<UICondition[]>(() => parseDefConditions(workflow?.definition));
  const [actions, setActions] = useState<UIAction[]>(() => parseDefActions(workflow?.definition));

  const triggerEntity = TRIGGER_ENTITY[triggerEvent] ?? "contact";

  const handleTriggerChange = (value: string) => {
    setTriggerEvent(value);
    const entity = TRIGGER_ENTITY[value] ?? "contact";
    const valid = ENTITY_STATUS_OPTIONS[entity].map((o) => o.value);
    // Keep any update_status actions pointing at a status valid for the new trigger.
    setActions((prev) =>
      prev.map((a) =>
        a.type === "update_status" && !valid.includes(a.statusValue)
          ? { ...a, statusValue: valid[0] }
          : a,
      ),
    );
  };

  const addCondition = () =>
    setConditions((c) => [...c, { id: nextId(), field: "stage", operator: "equals", value: "" }]);
  const updateCondition = (id: string, patch: Partial<UICondition>) =>
    setConditions((c) => c.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const removeCondition = (id: string) => setConditions((c) => c.filter((row) => row.id !== id));

  const addAction = (type: UIAction["type"]) =>
    setActions((a) => [...a, newAction(type, nextId(), ENTITY_STATUS_OPTIONS[triggerEntity][0].value)]);
  const updateAction = (id: string, patch: Partial<UIAction>) =>
    setActions((a) => a.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const removeAction = (id: string) => setActions((a) => a.filter((row) => row.id !== id));
  const changeActionType = (id: string, type: UIAction["type"]) => {
    const valid = ENTITY_STATUS_OPTIONS[triggerEntity].map((o) => o.value);
    setActions((a) =>
      a.map((row) =>
        row.id === id
          ? {
              ...row,
              type,
              statusValue:
                type === "update_status" && !valid.includes(row.statusValue)
                  ? ENTITY_STATUS_OPTIONS[triggerEntity][0].value
                  : row.statusValue,
            }
          : row,
      ),
    );
  };

  const actionsValid =
    actions.length > 0 &&
    actions.every((a) => (a.type === "create_task" ? a.title.trim().length > 0 : Boolean(a.statusValue)));
  const canSubmit = name.trim().length > 0 && actionsValid && !pending;

  const buildDefinition = () => {
    const builtConditions = conditions
      .filter((c) => c.field && (c.operator === "exists" || c.value.trim().length > 0))
      .map((c) => {
        if (c.operator === "exists") return { field: c.field, operator: c.operator };
        if (c.operator === "in")
          return {
            field: c.field,
            operator: c.operator,
            value: c.value.split(",").map((s) => s.trim()).filter(Boolean),
          };
        if (c.operator === "greater_than" || c.operator === "less_than")
          return { field: c.field, operator: c.operator, value: Number(c.value) };
        return { field: c.field, operator: c.operator, value: c.value.trim() };
      });

    const builtActions = actions.map((a) => {
      if (a.type === "create_task") {
        const action: Record<string, unknown> = {
          type: "create_task",
          title: a.title.trim(),
          priority: a.priority,
          status: a.taskStatus,
        };
        if (a.description.trim()) action.description = a.description.trim();
        if (a.dueInDays.trim() && Number.isFinite(Number(a.dueInDays)))
          action.due_in_days = Math.max(0, Math.floor(Number(a.dueInDays)));
        return action;
      }
      // update_status: no target_entity => the engine acts on the triggering record.
      return { type: "update_status", status: a.statusValue };
    });

    return { version: 1, conditions: builtConditions, actions: builtActions };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      if (editing && workflow) {
        await updateWorkflow.mutateAsync({
          workflowId: workflow.id,
          name: name.trim(),
          triggerEvent,
          definition: buildDefinition(),
        });
        toast.success("Workflow updated");
      } else {
        await createWorkflow.mutateAsync({
          name: name.trim(),
          triggerEvent,
          status: "active",
          definition: buildDefinition(),
        });
        toast.success("Workflow created");
      }
      onClose();
    } catch {
      toast.error(
        editing ? "Failed to update workflow. Please try again." : "Failed to create workflow. Please try again.",
      );
    }
  };

  const labelCls = "text-xs font-medium text-muted-foreground mb-1.5 block";
  const inputCls =
    "w-full px-3 py-2 text-sm bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const selectCls = `${inputCls} appearance-none cursor-pointer`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-[560px] max-h-[90vh] overflow-y-auto shadow-2xl shadow-black/40 animate-fade-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card z-10">
          <div>
            <h2 className="text-base font-semibold text-foreground">{editing ? "Edit Workflow" : "Create Workflow"}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">When something happens, run one or more actions</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div>
            <label className={labelCls}>Workflow name <span className="text-destructive">*</span></label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g., Follow up on new leads" className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
          </div>

          <div>
            <label className={labelCls}>When…</label>
            <select value={triggerEvent} onChange={(e) => handleTriggerChange(e.target.value)} className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer">
              {WORKFLOW_TRIGGERS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Conditions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Only if… <span className="text-muted-foreground/60">(optional · all must match)</span></label>
              <button type="button" onClick={addCondition} className="flex items-center gap-1 text-xs font-medium text-[hsl(var(--accent-violet))] hover:opacity-80 transition-opacity">
                <Plus className="w-3.5 h-3.5" /> Add condition
              </button>
            </div>
            {conditions.length === 0 ? (
              <p className="text-xs text-muted-foreground/70 italic">Runs on every matching event.</p>
            ) : (
              <div className="space-y-2">
                {conditions.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <select value={c.field} onChange={(e) => updateCondition(c.id, { field: e.target.value })} className={`${selectCls} flex-1`}>
                      {CONDITION_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                    <select value={c.operator} onChange={(e) => updateCondition(c.id, { operator: e.target.value as ConditionOperator })} className={`${selectCls} w-32 shrink-0`}>
                      {CONDITION_OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {c.operator !== "exists" && (
                      <input
                        type={c.operator === "greater_than" || c.operator === "less_than" ? "number" : "text"}
                        value={c.value}
                        onChange={(e) => updateCondition(c.id, { value: e.target.value })}
                        placeholder={c.operator === "in" ? "a, b" : "value"}
                        className={`${inputCls} w-28 shrink-0`}
                      />
                    )}
                    <button type="button" onClick={() => removeCondition(c.id)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground shrink-0">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">…then do <span className="text-destructive">*</span></label>
            <div className="space-y-3">
              {actions.map((a) => (
                <div key={a.id} className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <select value={a.type} onChange={(e) => changeActionType(a.id, e.target.value as UIAction["type"])} className={`${selectCls} text-xs font-semibold flex-1`}>
                      <option value="create_task">Create a task</option>
                      <option value="update_status">Update the {triggerEntity}&rsquo;s {ENTITY_STATUS_NOUN[triggerEntity]}</option>
                    </select>
                    {actions.length > 1 && (
                      <button type="button" onClick={() => removeAction(a.id)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {a.type === "create_task" ? (
                    <>
                      <div>
                        <label className={labelCls}>Task title <span className="text-destructive">*</span></label>
                        <input type="text" value={a.title} onChange={(e) => updateAction(a.id, { title: e.target.value })} placeholder="e.g., Call the new lead" className={inputCls} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>Priority</label>
                          <select value={a.priority} onChange={(e) => updateAction(a.id, { priority: e.target.value as UIAction["priority"] })} className={selectCls}>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="urgent">Urgent</option>
                          </select>
                        </div>
                        <div>
                          <label className={labelCls}>Due in (days)</label>
                          <input type="number" min={0} value={a.dueInDays} onChange={(e) => updateAction(a.id, { dueInDays: e.target.value })} placeholder="e.g., 2" className={inputCls} />
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>Description</label>
                        <input type="text" value={a.description} onChange={(e) => updateAction(a.id, { description: e.target.value })} placeholder="Optional details" className={inputCls} />
                      </div>
                    </>
                  ) : (
                    <div>
                      <label className={labelCls}>Set {ENTITY_STATUS_NOUN[triggerEntity]} to</label>
                      <select value={a.statusValue} onChange={(e) => updateAction(a.id, { statusValue: e.target.value })} className={selectCls}>
                        {ENTITY_STATUS_OPTIONS[triggerEntity].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <p className="text-[11px] text-muted-foreground/70 mt-1.5">Applies to the {triggerEntity} that triggered this workflow.</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => addAction("create_task")} className="flex items-center gap-1 text-xs font-medium text-[hsl(var(--accent-violet))] hover:opacity-80 transition-opacity">
                <Plus className="w-3.5 h-3.5" /> Add task
              </button>
              <button type="button" onClick={() => addAction("update_status")} className="flex items-center gap-1 text-xs font-medium text-[hsl(var(--accent-violet))] hover:opacity-80 transition-opacity">
                <Plus className="w-3.5 h-3.5" /> Change status
              </button>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">Cancel</button>
            <button type="submit" disabled={!canSubmit} className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--accent-violet))] text-white hover:bg-[hsl(var(--accent-violet))]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]">
              {pending ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> {editing ? "Saving…" : "Creating…"}</>) : (editing ? "Save Changes" : "Create Workflow")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AutomationsPage() {
  const { organizationId, companyId } = useOrg();
  const [search, setSearch] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<EditWorkflow | null>(null);
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
        <button
          onClick={() => setIsCreateOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-violet))] text-white hover:bg-[hsl(var(--accent-violet))]/90 transition-all shadow-md shadow-violet-500/20 active:scale-[0.97]"
        >
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
          action={!search ? { label: "Create Workflow", onClick: () => setIsCreateOpen(true) } : undefined}
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
          onEdit={(wf) => {
            setSelectedWorkflowId(null);
            setEditingWorkflow(wf);
          }}
        />
      )}

      {isCreateOpen && (
        <CreateWorkflowDialog orgId={organizationId} onClose={() => setIsCreateOpen(false)} />
      )}

      {editingWorkflow && (
        <CreateWorkflowDialog
          orgId={organizationId}
          workflow={editingWorkflow}
          onClose={() => setEditingWorkflow(null)}
        />
      )}
    </div>
  );
}
