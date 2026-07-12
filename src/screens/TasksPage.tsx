import { useState, useMemo, useEffect } from "react";
import {
  Plus,
  Search,
  Filter,
  AlertTriangle,
  Calendar,
  User,
  Clock,
  Zap,
  CheckCircle2,
  Circle,
  Loader2,
  Ban,
  MessageSquare,
  Send,
  X,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useOrg } from "@/lib/org-context";
import {
  useTasks,
  useTaskDetail,
  useCreateTask,
  useUpdateTaskStatus,
  useCompanies,
} from "@/lib/api-hooks";
import { SkeletonRow, ErrorBanner, EmptyState } from "@/components/ui/StateViews";
import { formatDate, relativeTime } from "@/lib/format";
import type { TaskListRow, TaskDetailResponse } from "@/lib/api-client";
import { toast } from "@/components/ui/sonner";

// ─── Styling maps ─────────────────────────────────────────────────────────────

const statusIcon: Record<string, React.ReactNode> = {
  todo: <Circle className="w-3.5 h-3.5 text-muted-foreground" />,
  in_progress: <Loader2 className="w-3.5 h-3.5 text-[hsl(var(--accent-blue))] animate-[spin_3s_linear_infinite]" />,
  blocked: <Ban className="w-3.5 h-3.5 text-[hsl(var(--urgent))]" />,
  completed: <CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--success))]" />,
};

const statusStyle: Record<string, string> = {
  todo: "text-muted-foreground",
  in_progress: "text-[hsl(var(--accent-blue))]",
  blocked: "text-[hsl(var(--urgent))]",
  completed: "text-[hsl(var(--success))]",
};

const statusLabel: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  completed: "Completed",
};

const priorityConfig: Record<string, { bg: string; text: string; dot: string }> = {
  urgent: { bg: "bg-[hsl(var(--urgent))]/10", text: "text-[hsl(var(--urgent))]", dot: "bg-[hsl(var(--urgent))]" },
  high: { bg: "bg-[hsl(var(--urgent))]/10", text: "text-[hsl(var(--urgent))]", dot: "bg-[hsl(var(--urgent))]" },
  medium: { bg: "bg-[hsl(var(--warning))]/10", text: "text-[hsl(var(--warning))]", dot: "bg-[hsl(var(--warning))]" },
  low: { bg: "bg-muted", text: "text-muted-foreground", dot: "bg-muted-foreground" },
};

// ─── Create Task Dialog ───────────────────────────────────────────────────────

function CreateTaskDialog({ onClose }: { onClose: () => void }) {
  const { organizationId, companyId: ctxCompanyId } = useOrg();
  const { data: companies } = useCompanies(organizationId);
  const createTask = useCreateTask(organizationId);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [status, setStatus] = useState<"todo" | "in_progress" | "blocked" | "completed">("todo");
  const [dueAt, setDueAt] = useState("");
  const [companyId, setCompanyId] = useState(
    ctxCompanyId != null ? ctxCompanyId : ""
  );

  // Set initial company if available and not already set
  useMemo(() => {
    if (companies && companies.length > 0 && !companyId && ctxCompanyId === null) {
      setCompanyId(companies[0].id);
    }
  }, [companies, companyId, ctxCompanyId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await createTask.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        priority,
        status,
        companyId: companyId || null,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
      toast.success("Task created successfully");
      onClose();
    } catch {
      toast.error("Failed to create task. Please try again.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-[500px] max-h-[90vh] overflow-y-auto shadow-2xl shadow-black/40 animate-fade-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground">New Task</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Create a new task to track work</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Title <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="e.g., Follow up with client"
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Company</label>
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer"
              >
                <option value="">No company</option>
                {companies?.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Due Date</label>
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Any additional details about this task..."
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createTask.isPending || !title.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
            >
              {createTask.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>
              ) : (
                "Create Task"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Status Quick-Update Dropdown ─────────────────────────────────────────────

type TaskStatus = "todo" | "in_progress" | "blocked" | "completed";

function StatusDropdown({
  taskId,
  currentStatus,
}: {
  taskId: string;
  currentStatus: string;
}) {
  const { organizationId } = useOrg();
  const updateStatus = useUpdateTaskStatus(organizationId, taskId);
  const [open, setOpen] = useState(false);

  const handleSelect = async (s: TaskStatus) => {
    setOpen(false);
    if (s === currentStatus) return;
    try {
      await updateStatus.mutateAsync(s);
      toast.success(`Status updated to ${statusLabel[s]}`);
    } catch {
      toast.error("Failed to update status");
    }
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium transition-colors hover:opacity-80",
          statusStyle[currentStatus] ?? "text-muted-foreground",
          updateStatus.isPending && "opacity-50 cursor-wait"
        )}
      >
        {updateStatus.isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          statusIcon[currentStatus] ?? <Circle className="w-3.5 h-3.5" />
        )}
        <span>{statusLabel[currentStatus] ?? currentStatus}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-40 bg-popover border border-border rounded-lg shadow-xl z-50 py-1 animate-scale-in">
            {(Object.keys(statusLabel) as TaskStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => handleSelect(s)}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs hover:bg-secondary transition-colors flex items-center gap-2",
                  currentStatus === s ? "text-foreground font-bold" : "text-muted-foreground"
                )}
              >
                {statusIcon[s]}
                {statusLabel[s]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Complete toggle (per-row) ────────────────────────────────────────────────

function TaskCompleteToggle({ taskId, currentStatus }: { taskId: string; currentStatus: string }) {
  const { organizationId } = useOrg();
  const updateStatus = useUpdateTaskStatus(organizationId, taskId);
  const done = currentStatus === "completed";

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await updateStatus.mutateAsync(done ? "todo" : "completed");
      toast.success(done ? "Task reopened" : "Task completed");
    } catch {
      toast.error("Failed to update task");
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={updateStatus.isPending}
      className="text-muted-foreground hover:text-[hsl(var(--success))] transition-colors disabled:opacity-50"
      aria-label={done ? "Reopen task" : "Mark task complete"}
    >
      {updateStatus.isPending ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : done ? (
        <CheckCircle2 className="w-4 h-4 text-[hsl(var(--success))]" />
      ) : (
        <Circle className="w-4 h-4" />
      )}
    </button>
  );
}

// ─── Tasks Page ───────────────────────────────────────────────────────────────

export default function TasksPage() {
  const { organizationId, companyId } = useOrg();
  const [search, setSearch] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // Quick Add / command-palette deep link: /tasks?new=task
  useEffect(() => {
    if (searchParams.get("new") !== "task") return;
    setIsCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const params = useMemo(() => ({
    companyId: companyId || undefined,
    search: search || undefined,
    status: statusFilter || undefined,
    priority: priorityFilter || undefined,
  }), [companyId, search, statusFilter, priorityFilter]);

  const { data: tasks, isLoading, isError, refetch } = useTasks(organizationId, params);
  const { data: detail, isLoading: isDetailLoading } = useTaskDetail(organizationId, selectedTaskId);
  const updateStatus = useUpdateTaskStatus(organizationId, selectedTaskId || "");

  const taskList = tasks?.rows?.items ?? [];

  const handleStatusUpdate = async (status: TaskStatus) => {
    if (!selectedTaskId) return;
    try {
      await updateStatus.mutateAsync(status);
      toast.success(`Task marked as ${statusLabel[status]}`);
    } catch {
      toast.error("Failed to update status");
    }
  };

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Track and manage operational work</p>
        </div>
        <button
          onClick={() => setIsCreateOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-all shadow-md shadow-blue-500/20 active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" />
          New Task
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search tasks..."
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
              statusFilter || priorityFilter ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground hover:text-foreground",
            )}
          >
            <Filter className="w-3.5 h-3.5" />
            Filter
            {(statusFilter || priorityFilter) && (
              <span className="ml-0.5 text-[10px] font-bold bg-primary text-primary-foreground rounded-full w-4 h-4 flex items-center justify-center">
                {(statusFilter ? 1 : 0) + (priorityFilter ? 1 : 0)}
              </span>
            )}
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
              <div className="absolute top-full right-0 mt-1 w-52 bg-popover border border-border rounded-lg shadow-xl z-50 p-3 space-y-3 animate-scale-in">
                <div>
                  <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Status</label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                  >
                    <option value="">All statuses</option>
                    <option value="todo">To Do</option>
                    <option value="in_progress">In Progress</option>
                    <option value="blocked">Blocked</option>
                    <option value="completed">Completed</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 block">Priority</label>
                  <select
                    value={priorityFilter}
                    onChange={(e) => setPriorityFilter(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs bg-secondary border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                  >
                    <option value="">All priorities</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                {(statusFilter || priorityFilter) && (
                  <button
                    onClick={() => { setStatusFilter(""); setPriorityFilter(""); }}
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

      <div className="flex-1 flex gap-6 min-h-0">
        {/* Task List */}
        <div className="flex-1 bg-card border border-border rounded-2xl overflow-hidden flex flex-col shadow-sm">
          <div className="overflow-y-auto flex-1 custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="bg-secondary/30 border-b border-border">
                  <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider w-10"></th>
                  <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Task</th>
                  <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Priority</th>
                  <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Company</th>
                  <th className="px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
                ) : isError ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8">
                      <ErrorBanner message="Failed to load tasks." onRetry={refetch} />
                    </td>
                  </tr>
                ) : taskList.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12">
                      <EmptyState title="No tasks found" description="Create a task to get started." />
                    </td>
                  </tr>
                ) : (
                  taskList.map((task) => (
                    <tr
                      key={task.id}
                      onClick={() => setSelectedTaskId(task.id)}
                      className={cn(
                        "hover:bg-secondary/40 transition-colors cursor-pointer group",
                        selectedTaskId === task.id && "bg-secondary/60"
                      )}
                    >
                      <td className="px-4 py-3">
                        <TaskCompleteToggle taskId={task.id} currentStatus={task.status} />
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm font-semibold text-foreground leading-tight">{task.title}</p>
                      </td>
                      <td className="px-4 py-3">
                        <StatusDropdown taskId={task.id} currentStatus={task.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className={cn("w-1.5 h-1.5 rounded-full", priorityConfig[task.priority]?.dot)} />
                          <span className={cn("text-[10px] font-bold uppercase tracking-wider", priorityConfig[task.priority]?.text)}>
                            {task.priority}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {task.company ? (
                          <span className="text-xs text-foreground/80">{task.company.name}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <Calendar className="w-3 h-3" />
                          <span>{task.dueAt ? formatDate(task.dueAt) : "No date"}</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detail Panel */}
        <div className="w-96 bg-card border border-border rounded-2xl flex flex-col shadow-sm overflow-hidden shrink-0">
          {!selectedTaskId ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4">
                <CheckCircle2 className="w-6 h-6 text-muted-foreground/40" />
              </div>
              <h3 className="text-sm font-bold text-foreground">Select a Task</h3>
              <p className="text-xs text-muted-foreground mt-1">Click on a task to view its full details, activity, and management options.</p>
            </div>
          ) : isDetailLoading ? (
            <div className="p-6 space-y-6">
              <div className="space-y-2">
                <div className="h-4 w-3/4 bg-secondary animate-pulse rounded" />
                <div className="h-3 w-1/2 bg-secondary animate-pulse rounded" />
              </div>
              <div className="space-y-4 pt-4">
                <div className="h-20 bg-secondary animate-pulse rounded-xl" />
                <div className="h-32 bg-secondary animate-pulse rounded-xl" />
              </div>
            </div>
          ) : detail ? (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Detail Header */}
              <div className="p-5 border-b border-border bg-secondary/10">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <h3 className="text-base font-bold text-foreground leading-tight">{detail.task.title}</h3>
                  <button onClick={() => setSelectedTaskId(null)} className="p-1 hover:bg-secondary rounded-md transition-colors">
                    <X className="w-4 h-4 text-muted-foreground" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5", statusStyle[detail.task.status], "bg-background border border-border")}>
                    {statusIcon[detail.task.status]}
                    {statusLabel[detail.task.status]}
                  </span>
                  <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider", priorityConfig[detail.task.priority]?.bg, priorityConfig[detail.task.priority]?.text)}>
                    {detail.task.priority}
                  </span>
                </div>
              </div>

              {/* Detail Content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
                {/* Meta Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Company</p>
                    <p className="text-xs font-medium text-foreground">{detail.linkedEntities.company?.name || "None"}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Due Date</p>
                    <p className="text-xs font-medium text-foreground">{detail.task.dueAt ? formatDate(detail.task.dueAt) : "No date"}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Assigned To</p>
                    <div className="flex items-center gap-1.5">
                      <div className="w-4 h-4 rounded-full bg-primary/10 flex items-center justify-center text-[8px] font-bold text-primary">
                        {detail.task.assignee?.initials || "—"}
                      </div>
                      <span className="text-xs font-medium text-foreground">{detail.task.assignee?.name || "Unassigned"}</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Created</p>
                    <p className="text-xs font-medium text-foreground">{relativeTime(detail.task.createdAt)}</p>
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Description</p>
                  <div className="bg-secondary/30 rounded-xl p-3 border border-border/50">
                    <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">
                      {detail.task.description || "No description provided."}
                    </p>
                  </div>
                </div>

                {/* Status Actions */}
                <div className="space-y-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Update Status</p>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(statusLabel) as TaskStatus[]).map((s) => (
                      <button
                        key={s}
                        onClick={() => handleStatusUpdate(s)}
                        disabled={updateStatus.isPending || detail.task.status === s}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border",
                          detail.task.status === s
                            ? "bg-secondary border-border text-foreground opacity-50 cursor-default"
                            : "bg-background border-border hover:border-primary/50 text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {statusIcon[s]}
                        {statusLabel[s]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Activity/Trace */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Activity History</p>
                    <Zap className="w-3 h-3 text-[hsl(var(--accent-violet))]" />
                  </div>
                  <div className="space-y-4 relative before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-border">
                    {detail.trace.length === 0 ? (
                      <p className="text-[10px] text-muted-foreground italic pl-8">No activity recorded yet.</p>
                    ) : (
                      detail.trace.map((item, i) => (
                        <div key={i} className="relative pl-8">
                          <div className="absolute left-0 top-1 w-6 h-6 rounded-full bg-card border border-border flex items-center justify-center z-10">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                          </div>
                          <div className="space-y-0.5">
                            <p className="text-xs font-medium text-foreground">{item.title}</p>
                            <p className="text-[10px] text-muted-foreground">{relativeTime(item.occurredAt)}</p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Quick Comment */}
              <div className="p-4 border-t border-border bg-secondary/20">
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Add a comment..."
                    className="w-full bg-card border border-border rounded-xl pl-4 pr-10 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-primary hover:bg-primary/10 rounded-lg transition-colors">
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {isCreateOpen && <CreateTaskDialog onClose={() => setIsCreateOpen(false)} />}
    </div>
  );
}
