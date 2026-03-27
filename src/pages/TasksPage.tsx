import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

import TaskDetailPanel from "@/components/tasks/TaskDetailPanel";
import { EmptyState, ErrorState, LoadingState } from "@/components/system/AsyncState";
import { useAppContext } from "@/lib/app-context";
import { apiRequest, toQueryString } from "@/lib/api";
import { formatDateTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface TaskListRow {
  assignee: { initials: string; name: string } | null;
  booking: { id: string; label: string } | null;
  commentsCount: number;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  dueAt: string | null;
  id: string;
  isOverdue: boolean;
  priority: "low" | "medium" | "high" | "urgent";
  status: "todo" | "in_progress" | "blocked" | "completed";
  title: string;
  workflow: { id: string; label: string } | null;
}

interface TasksListResponse {
  rows: {
    items: TaskListRow[];
  };
  summary: {
    blockedCount: number;
    completedCount: number;
    inProgressCount: number;
    overdueCount: number;
    todoCount: number;
  };
}

const statusOptions = ["all", "todo", "in_progress", "blocked", "completed"] as const;

function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function TasksPage() {
  const navigate = useNavigate();
  const { activeCompanyId, activeOrganizationId } = useAppContext();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<(typeof statusOptions)[number]>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "tasks", activeCompanyId ?? "all", search, status],
    queryFn: () =>
      apiRequest<TasksListResponse>(
        `/api/organizations/${activeOrganizationId}/ui/tasks${toQueryString({
          companyId: activeCompanyId,
          limit: 100,
          page: 1,
          search,
          status: status === "all" ? undefined : status,
        })}`,
      ),
  });

  if (tasksQuery.isLoading) {
    return <LoadingState label="Loading tasks..." />;
  }

  if (tasksQuery.error) {
    return (
      <ErrorState
        description={tasksQuery.error instanceof Error ? tasksQuery.error.message : "Unable to load tasks."}
        onRetry={() => tasksQuery.refetch()}
        title="Tasks unavailable"
      />
    );
  }

  const rows = tasksQuery.data.rows.items;
  const summary = tasksQuery.data.summary;

  useEffect(() => {
    setSelectedTaskId(null);
  }, [activeCompanyId, activeOrganizationId]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Tasks</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{rows.length} visible tasks in the active scope</p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4 text-primary" />
          Task lists and detail panels now use live API data.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {([
          ["todo", summary.todoCount],
          ["in_progress", summary.inProgressCount],
          ["blocked", summary.blockedCount],
          ["completed", summary.completedCount],
          ["overdue", summary.overdueCount],
        ] as Array<[string, number]>).map(([key, value]) => (
          <div key={key} className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{labelize(key)}</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground outline-none"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks..."
            value={search}
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-secondary p-1">
          {statusOptions.map((option) => (
            <button
              key={option}
              className={cn(
                "rounded-md px-3 py-2 text-xs font-medium transition-colors",
                option === status ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
              )}
              onClick={() => setStatus(option)}
            >
              {labelize(option)}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          description="There are no tasks for the current organization/company filters yet."
          title="No tasks found"
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Task</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Assignee</th>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3">Linked Contact</th>
                <th className="px-4 py-3">Company</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    "cursor-pointer border-b border-border/40 transition-colors hover:bg-secondary/20",
                    row.isOverdue && row.status !== "completed" && "bg-destructive/5",
                  )}
                  onClick={() => setSelectedTaskId(row.id)}
                >
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-foreground">{row.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.commentsCount} comment{row.commentsCount === 1 ? "" : "s"}
                      {row.workflow ? ` · ${row.workflow.label}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">{labelize(row.status)}</td>
                  <td className="px-4 py-3 text-sm text-foreground">{labelize(row.priority)}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{row.assignee?.name ?? "Unassigned"}</td>
                  <td className={cn("px-4 py-3 text-sm", row.isOverdue ? "text-destructive" : "text-muted-foreground")}>
                    {formatDateTime(row.dueAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {row.contact ? (
                      <button
                        className="text-primary"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/crm/${row.contact!.id}`);
                        }}
                      >
                        {row.contact.name}
                      </button>
                    ) : row.booking ? (
                      row.booking.label
                    ) : (
                      "Not linked"
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{row.company?.name ?? "No company"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedTaskId ? (
        <TaskDetailPanel
          onClose={() => setSelectedTaskId(null)}
          onNavigateCalendar={() => navigate("/calendar")}
          onNavigateContact={(id) => navigate(`/crm/${id}`)}
          taskId={selectedTaskId}
        />
      ) : null}
    </div>
  );
}
