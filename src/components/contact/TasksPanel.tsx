import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Plus, X, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCreateTask } from "@/lib/api-hooks";
import { toast } from "@/components/ui/sonner";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/StateViews";
import { formatDate } from "@/lib/format";
import type { ContactDetailResponse } from "@/lib/api-client";
import { priorityConfig, taskStatusConfig } from "@/components/contact/config";

export function TasksPanel({
  tasks,
  onNew,
}: {
  tasks: ContactDetailResponse["linkedTasks"];
  onNew: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{tasks.length} tasks</h3>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
        >
          <Plus className="w-3 h-3" />
          New Task
        </button>
      </div>
      {tasks.length === 0 ? (
        <EmptyState title="No tasks" description="No tasks linked to this contact." />
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {tasks.map((t, i) => {
            const pc = priorityConfig[t.priority] ?? priorityConfig.low;
            const tsc = taskStatusConfig[t.status] ?? taskStatusConfig.todo;
            return (
              <div
                key={t.id}
                onClick={() => navigate(`/tasks?task=${t.id}`)}
                className={cn(
                  "flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors cursor-pointer",
                  i < tasks.length - 1 && "border-b border-border/40",
                )}
              >
                <div className="flex items-center gap-3">
                  {t.status === "completed" ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Circle className="w-4 h-4 text-muted-foreground" />
                  )}
                  <div>
                    <p className={cn("text-sm font-medium", t.status === "completed" ? "text-muted-foreground line-through" : "text-foreground")}>
                      {t.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t.assignee?.name ?? "Unassigned"}
                      {t.dueAt && ` · Due ${formatDate(t.dueAt, "MMM d")}`}
                      {t.isOverdue && <span className="text-destructive ml-1">· Overdue</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", pc.bg, pc.text)}>{t.priority}</span>
                  <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md", tsc.bg, tsc.text)}>{t.status}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CreateTaskDialog({
  orgId,
  companyId,
  contactId,
  onClose,
}: {
  orgId: string;
  companyId: string | null;
  contactId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const createTask = useCreateTask(orgId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [dueAt, setDueAt] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await createTask.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        priority,
        companyId,
        contactId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
      await qc.invalidateQueries({ queryKey: ["crm", "contact", orgId, contactId] });
      toast.success("Task created");
      onClose();
    } catch {
      toast.error("Failed to create task. Please try again.");
    }
  };

  return (
    <Modal onClose={onClose} size="md">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">New Task</h2>
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
            autoFocus
            placeholder="e.g., Follow up with this contact"
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
            placeholder="Any additional details..."
            className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
          />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={createTask.isPending || !title.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            {createTask.isPending ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>) : "Create Task"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
