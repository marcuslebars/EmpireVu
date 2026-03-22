import { useState } from "react";
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
import { useNavigate } from "react-router-dom";
import { useOrg } from "@/lib/org-context";
import {
  useTasks,
  useTaskDetail,
  useCreateTask,
  useUpdateTaskStatus,
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

const COMPANY_OPTIONS = [
  { id: "1", name: "A1 Marine Care" },
  { id: "2", name: "RankLocal" },
  { id: "3", name: "MarineMecca" },
  { id: "4", name: "Vitatee" },
];

// ─── Create Task Dialog ───────────────────────────────────────────────────────

function CreateTaskDialog({ onClose }: { onClose: () => void }) {
  const { organizationId, companyId: ctxCompanyId } = useOrg();
  const createTask = useCreateTask(organizationId);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [status, setStatus] = useState<"todo" | "in_progress" | "blocked" | "completed">("todo");
  const [dueAt, setDueAt] = useState("");
  const [companyId, setCompanyId] = useState(
    ctxCompanyId !== "all" ? ctxCompanyId : COMPANY_OPTIONS[0].id
  );

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
                {COMPANY_OPTIONS.map((c) => (
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
          statusIcon[currentStatus] ?? statusIcon.todo
        )}
        {statusLabel[currentStatus] ?? currentStatus}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 bg-card border border-border rounded-lg shadow-lg shadow-black/20 py-1 min-w-[140px]">
            {(["todo", "in_progress", "blocked", "completed"] as TaskStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => handleSelect(s)}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary flex items-center gap-2",
                  s === currentStatus ? `${statusStyle[s]} font-semibold` : "text-foreground"
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

// ─── Task Detail Panel ────────────────────────────────────────────────────────

function TaskDetailPanel({
  taskId,
  onClose,
  onNavigateContact,
  onNavigateCalendar,
}: {
  taskId: string;
  onClose: () => void;
  onNavigateContact: (id: string) => void;
  onNavigateCalendar: () => void;
}) {
  const { organizationId } = useOrg();
  const { data, isLoading, isError } = useTaskDetail(organizationId, taskId);
  const updateStatus = useUpdateTaskStatus(organizationId, taskId);
  const [commentText, setCommentText] = useState("");

  const handleStatusChange = async (s: TaskStatus) => {
    try {
      await updateStatus.mutateAsync(s);
      toast.success(`Status updated to ${statusLabel[s]}`);
    } catch {
      toast.error("Failed to update status");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[520px] h-full bg-[hsl(var(--surface-1))] border-l border-border overflow-y-auto animate-slide-in-right">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[hsl(var(--surface-1))]/95 backdrop-blur-md border-b border-border px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {data?.workflowOrigin.workflow && (
                <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-[hsl(var(--accent-violet))]/10 text-[hsl(var(--accent-violet))]">
                  <Zap className="w-2.5 h-2.5" />
                  Auto-generated
                </span>
              )}
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[hsl(var(--surface-2))] transition-colors text-muted-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          {isLoading ? (
            <div className="h-6 bg-secondary/80 animate-pulse rounded-md w-2/3 mt-2" />
          ) : (
            <h2 className="text-lg font-semibold text-foreground mt-2 leading-tight">{data?.task.title}</h2>
          )}
        </div>

        <div className="px-6 py-5 space-y-6">
          {isLoading && (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-3 bg-secondary/80 animate-pulse rounded-md" style={{ width: `${70 - i * 10}%` }} />
              ))}
            </div>
          )}

          {isError && (
            <p className="text-sm text-destructive">Failed to load task details.</p>
          )}

          {data && (
            <>
              {/* Overdue Banner */}
              {data.task.isOverdue && data.task.status !== "completed" && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[hsl(var(--urgent))]/8 border border-[hsl(var(--urgent))]/20">
                  <Clock className="w-3.5 h-3.5 text-[hsl(var(--urgent))] animate-pulse" />
                  <span className="text-xs font-medium text-[hsl(var(--urgent))]">
                    This task is overdue
                    {data.task.dueAt && ` — due ${formatDate(data.task.dueAt, "MMM d")}`}
                  </span>
                </div>
              )}

              {/* System Trace */}
              {data.trace.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Zap className="w-3 h-3 text-[hsl(var(--accent-violet))]" />
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">System Trace</h3>
                  </div>
                  <div className="bg-[hsl(var(--surface-2))]/60 rounded-lg p-3 border border-border/50 space-y-2">
                    {data.trace.map((event, i) => (
                      <div key={event.id} className="flex gap-2.5 relative">
                        {i < data.trace.length - 1 && (
                          <div className="absolute left-[9px] top-5 bottom-0 w-px bg-border/50" />
                        )}
                        <div className="w-[18px] h-[18px] rounded-full bg-[hsl(var(--accent-violet))]/15 flex items-center justify-center shrink-0 mt-0.5 z-10">
                          <Zap className="w-2.5 h-2.5 text-[hsl(var(--accent-violet))]" />
                        </div>
                        <div className="pb-2 flex-1">
                          <p className="text-xs font-medium text-foreground">{event.title}</p>
                          <p className="text-[11px] text-muted-foreground">{event.detail}</p>
                        </div>
                        <span className="text-[10px] text-muted-foreground/60 shrink-0">{relativeTime(event.occurredAt)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Meta Grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Status</span>
                  <div className="flex items-center gap-2">
                    <span className={cn("text-sm font-medium", statusStyle[data.task.status] ?? "text-foreground")}>
                      {statusLabel[data.task.status] ?? data.task.status}
                    </span>
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Priority</span>
                  {(() => {
                    const pc = priorityConfig[data.task.priority] ?? priorityConfig.low;
                    return (
                      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-md", pc.bg, pc.text)}>
                        <span className={cn("w-1.5 h-1.5 rounded-full", pc.dot)} />
                        {data.task.priority}
                      </span>
                    );
                  })()}
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Assignee</span>
                  <div className="flex items-center gap-2">
                    {data.task.assignee ? (
                      <>
                        <div className="w-5 h-5 rounded-full bg-[hsl(var(--surface-3))] flex items-center justify-center text-[9px] font-semibold text-foreground">
                          {data.task.assignee.initials}
                        </div>
                        <span className="text-sm text-foreground">{data.task.assignee.name}</span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">Unassigned</span>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Due Date</span>
                  <span className={cn("text-sm", data.task.isOverdue && data.task.status !== "completed" ? "text-[hsl(var(--urgent))] font-medium" : "text-foreground")}>
                    {data.task.dueAt ? formatDate(data.task.dueAt, "MMM d, yyyy") : "—"}
                  </span>
                </div>
                {data.linkedEntities.company && (
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Company</span>
                    <span className="text-sm text-foreground">{data.linkedEntities.company.name}</span>
                  </div>
                )}
              </div>

              {/* Description */}
              {data.task.description && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Description</h3>
                  <p className="text-sm text-foreground/80 leading-relaxed">{data.task.description}</p>
                </div>
              )}

              {/* Linked Entities */}
              {(data.linkedEntities.contact || data.linkedEntities.booking) && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Connected To</h3>
                  <div className="space-y-2">
                    {data.linkedEntities.contact && (
                      <button
                        onClick={() => onNavigateContact(data.linkedEntities.contact!.id)}
                        className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg bg-[hsl(var(--surface-2))] border border-border hover:border-[hsl(var(--accent-blue))]/30 transition-all group"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="p-1.5 rounded-md bg-[hsl(var(--accent-blue))]/10">
                            <User className="w-3.5 h-3.5 text-[hsl(var(--accent-blue))]" />
                          </div>
                          <div className="text-left">
                            <p className="text-sm font-medium text-foreground">{data.linkedEntities.contact.name}</p>
                            <p className="text-[11px] text-muted-foreground">CRM Contact</p>
                          </div>
                        </div>
                        <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-[hsl(var(--accent-blue))] transition-colors" />
                      </button>
                    )}
                    {data.linkedEntities.booking && (
                      <button
                        onClick={onNavigateCalendar}
                        className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg bg-[hsl(var(--surface-2))] border border-border hover:border-[hsl(var(--accent-violet))]/30 transition-all group"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="p-1.5 rounded-md bg-[hsl(var(--accent-violet))]/10">
                            <Calendar className="w-3.5 h-3.5 text-[hsl(var(--accent-violet))]" />
                          </div>
                          <div className="text-left">
                            <p className="text-sm font-medium text-foreground">{data.linkedEntities.booking.label}</p>
                            <p className="text-[11px] text-muted-foreground">Calendar Booking</p>
                          </div>
                        </div>
                        <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-[hsl(var(--accent-violet))] transition-colors" />
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Workflow Origin */}
              {data.workflowOrigin.workflow && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Workflow Origin</h3>
                  <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-[hsl(var(--accent-violet))]/5 border border-[hsl(var(--accent-violet))]/15">
                    <Zap className="w-3.5 h-3.5 text-[hsl(var(--accent-violet))]" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{data.workflowOrigin.workflow.label}</p>
                      {data.workflowOrigin.latestRun && (
                        <p className="text-[11px] text-muted-foreground">
                          {data.workflowOrigin.latestRun.status}
                          {data.workflowOrigin.latestRun.completedAt && ` · ${relativeTime(data.workflowOrigin.latestRun.completedAt)}`}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Comments */}
              {data.comments.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Activity</h3>
                  <div className="space-y-0">
                    {data.comments.map((comment, i) => (
                      <div key={comment.id} className="flex gap-3 py-2.5 relative">
                        {i < data.comments.length - 1 && (
                          <div className="absolute left-[13px] top-10 w-px h-[calc(100%-16px)] bg-border" />
                        )}
                        <div className="w-[26px] h-[26px] rounded-full bg-[hsl(var(--accent-blue))]/10 flex items-center justify-center shrink-0">
                          <MessageSquare className="w-3 h-3 text-[hsl(var(--accent-blue))]" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-foreground/80">
                            <span className="font-medium text-foreground">{comment.author?.name ?? "System"}</span>{" "}
                            {comment.body}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{relativeTime(comment.createdAt)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Comment Input */}
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Add Comment</h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Write a comment..."
                    className="flex-1 bg-[hsl(var(--surface-2))] border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--accent-blue))]/50"
                  />
                  <button className="p-2 rounded-lg bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-colors active:scale-[0.97]">
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Status Actions */}
              <div className="space-y-2 pt-2 border-t border-border">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Update Status</h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {(["todo", "in_progress", "blocked", "completed"] as TaskStatus[]).map((s) => {
                    const isCurrent = data.task.status === s;
                    return (
                      <button
                        key={s}
                        onClick={() => handleStatusChange(s)}
                        disabled={isCurrent || updateStatus.isPending}
                        className={cn(
                          "flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-150 active:scale-[0.97]",
                          isCurrent
                            ? "bg-[hsl(var(--accent-blue))]/10 text-[hsl(var(--accent-blue))] border border-[hsl(var(--accent-blue))]/30 cursor-default"
                            : "bg-[hsl(var(--surface-2))] text-foreground hover:bg-[hsl(var(--surface-3))]",
                          updateStatus.isPending && "opacity-50 cursor-wait"
                        )}
                      >
                        {updateStatus.isPending ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          statusIcon[s]
                        )}
                        {statusLabel[s]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tasks Page ───────────────────────────────────────────────────────────────

const UI_STATUSES = ["All", "To Do", "In Progress", "Blocked", "Completed"] as const;
const UI_PRIORITIES = ["All", "High", "Medium", "Low"] as const;

const uiStatusToApi: Record<string, string> = {
  "To Do": "todo",
  "In Progress": "in_progress",
  "Blocked": "blocked",
  "Completed": "completed",
};

const uiPriorityToApi: Record<string, string> = {
  "High": "high",
  "Medium": "medium",
  "Low": "low",
};

export default function TasksPage() {
  const navigate = useNavigate();
  const { organizationId, companyId } = useOrg();

  const [activeStatus, setActiveStatus] = useState("All");
  const [activePriority, setActivePriority] = useState("All");
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const handleSearch = (value: string) => {
    setSearch(value);
    clearTimeout((handleSearch as any)._t);
    (handleSearch as any)._t = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const apiStatus = activeStatus !== "All" ? uiStatusToApi[activeStatus] : undefined;
  const apiPriority = activePriority !== "All" ? uiPriorityToApi[activePriority] : undefined;
  const apiCompanyId = companyId !== "all" ? companyId : undefined;

  const { data, isLoading, isError, refetch } = useTasks(organizationId, {
    search: debouncedSearch || undefined,
    status: apiStatus,
    priority: apiPriority,
    companyId: apiCompanyId,
    pageSize: 50,
  });

  const tasks = data?.rows.items ?? [];
  const summary = data?.summary;
  const totalCount = data?.rows.pagination.total ?? 0;

  const overdueCount = tasks.filter((t) => t.isOverdue && t.status !== "completed").length;
  const blockedCount = summary?.blockedCount ?? tasks.filter((t) => t.status === "blocked").length;

  const statusCounts = {
    "To Do": summary?.todoCount ?? 0,
    "In Progress": summary?.inProgressCount ?? 0,
    "Blocked": summary?.blockedCount ?? 0,
    "Completed": summary?.completedCount ?? 0,
  };

  return (
    <div className="max-w-[1400px] mx-auto space-y-5">
      {/* Create Task Dialog */}
      {showCreateDialog && (
        <CreateTaskDialog onClose={() => setShowCreateDialog(false)} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isLoading ? "Loading..." : `${totalCount} tasks`}
          </p>
        </div>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-all active:scale-[0.97] shadow-[0_0_20px_hsl(var(--accent-blue)/0.2)]"
        >
          <Plus className="w-4 h-4" />
          New Task
        </button>
      </div>

      {/* Error */}
      {isError && (
        <ErrorBanner message="Failed to load tasks." onRetry={() => refetch()} />
      )}

      {/* Urgent Banner */}
      {(overdueCount > 0 || blockedCount > 0) && !isLoading && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[hsl(var(--urgent))]/8 border border-[hsl(var(--urgent))]/20 opacity-0 animate-fade-in" style={{ animationDelay: "60ms" }}>
          <div className="p-1.5 rounded-lg bg-[hsl(var(--urgent))]/15">
            <AlertTriangle className="w-4 h-4 text-[hsl(var(--urgent))] animate-pulse" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              {overdueCount > 0 && <span>{overdueCount} overdue task{overdueCount > 1 ? "s" : ""}</span>}
              {overdueCount > 0 && blockedCount > 0 && <span className="text-muted-foreground mx-1.5">·</span>}
              {blockedCount > 0 && <span>{blockedCount} blocked</span>}
            </p>
          </div>
          <button className="text-xs font-medium text-[hsl(var(--urgent))] hover:underline" onClick={() => setActiveStatus("Blocked")}>
            View all →
          </button>
        </div>
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-4 gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
        {(Object.entries(statusCounts) as [string, number][]).map(([status, count]) => (
          <button
            key={status}
            onClick={() => setActiveStatus(activeStatus === status ? "All" : status)}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-xl border transition-all active:scale-[0.98]",
              activeStatus === status
                ? "bg-[hsl(var(--surface-2))] border-[hsl(var(--accent-blue))]/30"
                : "bg-[hsl(var(--surface-1))] border-border hover:border-border/80"
            )}
          >
            {statusIcon[uiStatusToApi[status] ?? "todo"]}
            <div className="text-left">
              <p className="text-lg font-semibold text-foreground tabular-nums">
                {isLoading ? "—" : count}
              </p>
              <p className="text-[11px] text-muted-foreground">{status}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Filters Bar */}
      <div className="flex items-center justify-between opacity-0 animate-fade-in" style={{ animationDelay: "140ms" }}>
        <div className="flex items-center gap-2">
          {/* Status Tabs */}
          <div className="flex items-center gap-1 bg-[hsl(var(--surface-1))] border border-border rounded-lg p-0.5">
            {UI_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setActiveStatus(s)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                  activeStatus === s
                    ? "bg-[hsl(var(--surface-3))] text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {s}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
              showFilters
                ? "bg-[hsl(var(--surface-2))] border-[hsl(var(--accent-blue))]/30 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--surface-1))]"
            )}
          >
            <Filter className="w-3 h-3" />
            Filters
          </button>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search tasks..."
            className="bg-[hsl(var(--surface-1))] border border-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--accent-blue))]/50 w-56"
          />
        </div>
      </div>

      {/* Extended Filters */}
      {showFilters && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[hsl(var(--surface-1))] border border-border opacity-0 animate-fade-in">
          <span className="text-xs text-muted-foreground">Priority:</span>
          <div className="flex gap-1">
            {UI_PRIORITIES.map((p) => (
              <button
                key={p}
                onClick={() => setActivePriority(p)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  activePriority === p ? "bg-[hsl(var(--surface-3))] text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Task Table */}
      <div className="bg-[hsl(var(--surface-1))] border border-border rounded-xl overflow-hidden opacity-0 animate-fade-in" style={{ animationDelay: "180ms" }}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Task</th>
              <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Status</th>
              <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Priority</th>
              <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Assignee</th>
              <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Due</th>
              <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Linked</th>
              <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Company</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={7} className="px-0 py-0">
                    <SkeletonRow cols={6} />
                  </td>
                </tr>
              ))
            ) : tasks.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState title="No tasks found" description="Try adjusting your filters." />
                </td>
              </tr>
            ) : (
              tasks.map((task) => {
                const pc = priorityConfig[task.priority] ?? priorityConfig.low;
                return (
                  <tr
                    key={task.id}
                    onClick={() => setSelectedTaskId(selectedTaskId === task.id ? null : task.id)}
                    className={cn(
                      "border-b border-border/40 last:border-b-0 cursor-pointer transition-colors group",
                      task.isOverdue && task.status !== "completed" && "bg-[hsl(var(--urgent))]/[0.03]",
                      selectedTaskId === task.id ? "bg-[hsl(var(--accent-blue))]/[0.06]" : "hover:bg-[hsl(var(--surface-2))]/50"
                    )}
                  >
                    {/* Task */}
                    <td className="px-4 py-3 max-w-[320px]">
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5">{statusIcon[task.status] ?? statusIcon.todo}</div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {task.isOverdue && task.status !== "completed" && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[hsl(var(--urgent))]/15 text-[hsl(var(--urgent))]">OVERDUE</span>
                            )}
                            {task.workflow && (
                              <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-[hsl(var(--accent-violet))]/10 text-[hsl(var(--accent-violet))]">
                                <Zap className="w-2.5 h-2.5" />
                                Auto-generated
                              </span>
                            )}
                          </div>
                          <p className={cn(
                            "text-sm font-medium mt-0.5 truncate",
                            task.status === "completed" ? "text-muted-foreground line-through" : "text-foreground"
                          )}>
                            {task.title}
                          </p>
                        </div>
                      </div>
                    </td>

                    {/* Status — inline quick-update */}
                    <td className="px-4 py-3">
                      <StatusDropdown taskId={task.id} currentStatus={task.status} />
                    </td>

                    {/* Priority */}
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-md", pc.bg, pc.text)}>
                        <span className={cn("w-1.5 h-1.5 rounded-full", pc.dot)} />
                        {task.priority}
                      </span>
                    </td>

                    {/* Assignee */}
                    <td className="px-4 py-3">
                      {task.assignee ? (
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-[hsl(var(--surface-3))] flex items-center justify-center text-[10px] font-semibold text-foreground">
                            {task.assignee.initials}
                          </div>
                          <span className="text-xs text-muted-foreground hidden xl:inline">{task.assignee.name.split(" ")[0]}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>

                    {/* Due */}
                    <td className="px-4 py-3">
                      <span className={cn(
                        "text-xs tabular-nums",
                        task.isOverdue && task.status !== "completed" ? "text-[hsl(var(--urgent))] font-medium" : "text-muted-foreground"
                      )}>
                        {task.dueAt ? formatDate(task.dueAt, "MMM d") : "—"}
                      </span>
                    </td>

                    {/* Linked */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {task.contact && (
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate(`/crm/${task.contact!.id}`); }}
                            className="flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-[hsl(var(--surface-2))] text-[hsl(var(--accent-blue))] hover:bg-[hsl(var(--surface-3))] transition-colors"
                          >
                            <User className="w-2.5 h-2.5" />
                            {task.contact.name.split(" ")[0]}
                          </button>
                        )}
                        {task.booking && (
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate("/calendar"); }}
                            className="flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-[hsl(var(--surface-2))] text-[hsl(var(--accent-violet))] hover:bg-[hsl(var(--surface-3))] transition-colors"
                          >
                            <Calendar className="w-2.5 h-2.5" />
                            Booking
                          </button>
                        )}
                        {!task.contact && !task.booking && (
                          <span className="text-[11px] text-muted-foreground/50">—</span>
                        )}
                      </div>
                    </td>

                    {/* Company */}
                    <td className="px-4 py-3">
                      {task.company ? (
                        <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-[hsl(var(--accent-blue))]/15 text-[hsl(var(--accent-blue))]">
                          {task.company.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Task Detail Panel */}
      {selectedTaskId && (
        <TaskDetailPanel
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onNavigateContact={(id) => navigate(`/crm/${id}`)}
          onNavigateCalendar={() => navigate("/calendar")}
        />
      )}
    </div>
  );
}
