import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, CheckCircle2, Clock, Link2, MessageSquare, User, Workflow, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/system/AsyncState";
import { useAppContext } from "@/lib/app-context";
import { apiRequest, toQueryString } from "@/lib/api";
import { formatDateTime } from "@/lib/formatters";

interface TaskDetailResponse {
  comments: Array<{
    author: { name: string } | null;
    body: string;
    createdAt: string;
    id: string;
  }>;
  linkedEntities: {
    booking: { id: string; label: string } | null;
    company: { id: string; name: string } | null;
    contact: { id: string; name: string } | null;
    workflow: { id: string; label: string } | null;
  };
  task: {
    assignee: { id: string; name: string } | null;
    createdAt: string;
    description: string | null;
    dueAt: string | null;
    id: string;
    isOverdue: boolean;
    priority: string;
    status: "todo" | "in_progress" | "blocked" | "completed";
    title: string;
  };
  trace: Array<{
    detail: string;
    id: string;
    kind: string;
    occurredAt: string;
    status: string | null;
    title: string;
  }>;
  workflowOrigin: {
    latestRun: {
      createdAt: string;
      failureReason: string | null;
      id: string;
      status: string;
    } | null;
    workflow: { id: string; label: string } | null;
  };
}

interface OrganizationMemberOption {
  email: string;
  id: string;
  name: string;
  role: string;
}

interface Props {
  onClose: () => void;
  onNavigateCalendar: () => void;
  onNavigateContact: (id: string) => void;
  taskId: string;
}

const nextStatuses: Record<TaskDetailResponse["task"]["status"], TaskDetailResponse["task"]["status"][]> = {
  blocked: ["in_progress", "completed"],
  completed: [],
  in_progress: ["blocked", "completed"],
  todo: ["in_progress", "completed"],
};

function labelizeStatus(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function TaskDetailPanel({ taskId, onClose, onNavigateCalendar, onNavigateContact }: Props) {
  const queryClient = useQueryClient();
  const { activeCompanyId, activeOrganizationId } = useAppContext();
  const [selectedAssigneeId, setSelectedAssigneeId] = useState("");
  const taskQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "tasks", "detail", taskId, activeCompanyId ?? "all"],
    queryFn: () =>
      apiRequest<TaskDetailResponse>(
        `/api/organizations/${activeOrganizationId}/ui/tasks/${taskId}${toQueryString({
          companyId: activeCompanyId,
        })}`,
      ),
  });
  const membersQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "members"],
    queryFn: () => apiRequest<OrganizationMemberOption[]>(`/api/organizations/${activeOrganizationId}/members`),
  });
  const updateStatusMutation = useMutation({
    mutationFn: (status: TaskDetailResponse["task"]["status"]) =>
      apiRequest(`/api/organizations/${activeOrganizationId}/tasks/${taskId}`, {
        body: JSON.stringify({ status }),
        method: "PATCH",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "tasks", "detail", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "dashboard"] }),
      ]);
    },
  });
  const assignUserMutation = useMutation({
    mutationFn: (assignedToProfileId: string) =>
      apiRequest(`/api/organizations/${activeOrganizationId}/tasks/${taskId}`, {
        body: JSON.stringify({ assignedToProfileId }),
        method: "PATCH",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "tasks", "detail", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["org", activeOrganizationId, "dashboard"] }),
      ]);
    },
  });

  useEffect(() => {
    if (!taskQuery.data) {
      return;
    }

    setSelectedAssigneeId(taskQuery.data.task.assignee?.id ?? "");
  }, [taskQuery.data]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-[540px] overflow-y-auto border-l border-border bg-card">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card/95 px-6 py-4 backdrop-blur-sm">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Task Detail</p>
            <p className="text-sm font-medium text-foreground">{taskId}</p>
          </div>
          <button className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {taskQuery.isLoading ? <LoadingState label="Loading task details..." /> : null}
          {taskQuery.error ? (
            <ErrorState
              description={taskQuery.error instanceof Error ? taskQuery.error.message : "Unable to load the task detail."}
              onRetry={() => taskQuery.refetch()}
              title="Task detail unavailable"
            />
          ) : null}
          {taskQuery.data ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-foreground">{taskQuery.data.task.title}</h2>
                  <span className="rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">
                    {labelizeStatus(taskQuery.data.task.status)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {taskQuery.data.task.description ?? "No task description was provided."}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-secondary/60 p-3">
                  <p className="text-xs text-muted-foreground">Assignee</p>
                  <p className="text-sm font-medium text-foreground">{taskQuery.data.task.assignee?.name ?? "Unassigned"}</p>
                </div>
                <div className="rounded-lg bg-secondary/60 p-3">
                  <p className="text-xs text-muted-foreground">Due</p>
                  <p className="text-sm font-medium text-foreground">{formatDateTime(taskQuery.data.task.dueAt)}</p>
                </div>
                <div className="rounded-lg bg-secondary/60 p-3">
                  <p className="text-xs text-muted-foreground">Priority</p>
                  <p className="text-sm font-medium text-foreground">{labelizeStatus(taskQuery.data.task.priority)}</p>
                </div>
                <div className="rounded-lg bg-secondary/60 p-3">
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p className="text-sm font-medium text-foreground">{formatDateTime(taskQuery.data.task.createdAt)}</p>
                </div>
              </div>

              {nextStatuses[taskQuery.data.task.status].length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">Quick Status Update</p>
                  <div className="flex flex-wrap gap-2">
                    {nextStatuses[taskQuery.data.task.status].map((status) => (
                      <Button
                        key={status}
                        disabled={updateStatusMutation.isPending}
                        onClick={() => updateStatusMutation.mutate(status)}
                        size="sm"
                        variant="outline"
                      >
                        {labelizeStatus(status)}
                      </Button>
                    ))}
                  </div>
                  {updateStatusMutation.error ? (
                    <p className="text-sm text-destructive">
                      {updateStatusMutation.error instanceof Error ? updateStatusMutation.error.message : "Unable to update task status."}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Assignee</p>
                {membersQuery.isLoading ? <p className="text-xs text-muted-foreground">Loading assignees...</p> : null}
                {membersQuery.error ? <p className="text-xs text-destructive">{membersQuery.error instanceof Error ? membersQuery.error.message : "Unable to load organization members."}</p> : null}
                {!membersQuery.isLoading && !membersQuery.error ? (
                  <div className="flex items-center gap-2">
                    <select
                      className="min-w-[220px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                      value={selectedAssigneeId}
                      onChange={(event) => {
                        const nextAssigneeId = event.target.value;
                        setSelectedAssigneeId(nextAssigneeId);

                        if (!nextAssigneeId || nextAssigneeId === taskQuery.data.task.assignee?.id) {
                          return;
                        }

                        assignUserMutation.mutate(nextAssigneeId);
                      }}
                    >
                      <option value="">Select assignee</option>
                      {(membersQuery.data ?? []).map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                    {assignUserMutation.isPending ? <span className="text-xs text-muted-foreground">Saving...</span> : null}
                  </div>
                ) : null}
                {assignUserMutation.error ? (
                  <p className="text-sm text-destructive">
                    {assignUserMutation.error instanceof Error ? assignUserMutation.error.message : "Unable to assign the task user."}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Linked Entities</p>
                <div className="space-y-2">
                  {taskQuery.data.linkedEntities.contact ? (
                    <button
                      className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-background/40 px-4 py-3 text-left transition-colors hover:border-primary/40"
                      onClick={() => onNavigateContact(taskQuery.data.linkedEntities.contact!.id)}
                    >
                      <div className="flex items-center gap-3">
                        <User className="h-4 w-4 text-primary" />
                        <div>
                          <p className="text-sm font-medium text-foreground">{taskQuery.data.linkedEntities.contact.name}</p>
                          <p className="text-xs text-muted-foreground">Linked contact</p>
                        </div>
                      </div>
                    </button>
                  ) : null}
                  {taskQuery.data.linkedEntities.booking ? (
                    <button
                      className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-background/40 px-4 py-3 text-left transition-colors hover:border-primary/40"
                      onClick={onNavigateCalendar}
                    >
                      <div className="flex items-center gap-3">
                        <Calendar className="h-4 w-4 text-primary" />
                        <div>
                          <p className="text-sm font-medium text-foreground">{taskQuery.data.linkedEntities.booking.label}</p>
                          <p className="text-xs text-muted-foreground">Linked booking</p>
                        </div>
                      </div>
                    </button>
                  ) : null}
                  {taskQuery.data.linkedEntities.workflow ? (
                    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-4 py-3">
                      <Workflow className="h-4 w-4 text-primary" />
                      <div>
                        <p className="text-sm font-medium text-foreground">{taskQuery.data.linkedEntities.workflow.label}</p>
                        <p className="text-xs text-muted-foreground">Origin workflow</p>
                      </div>
                    </div>
                  ) : null}
                  {!taskQuery.data.linkedEntities.contact && !taskQuery.data.linkedEntities.booking && !taskQuery.data.linkedEntities.workflow ? (
                    <EmptyState description="This task is not currently linked to a contact, booking, or workflow." title="No linked entities" />
                  ) : null}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">System Trace</p>
                {taskQuery.data.trace.length === 0 ? (
                  <EmptyState description="Trace events will appear here as activity, workflow runs, and comments accumulate." title="No trace events" />
                ) : (
                  <div className="space-y-2">
                    {taskQuery.data.trace.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">{item.title}</p>
                            <p className="text-xs text-muted-foreground">{item.detail}</p>
                          </div>
                          <span className="text-xs text-muted-foreground">{formatDateTime(item.occurredAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Comments</p>
                {taskQuery.data.comments.length === 0 ? (
                  <EmptyState description="No comments have been added to this task yet." title="No comments" />
                ) : (
                  <div className="space-y-2">
                    {taskQuery.data.comments.map((comment) => (
                      <div key={comment.id} className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <MessageSquare className="h-4 w-4" />
                          <span>{comment.author?.name ?? "Unknown author"}</span>
                          <span>·</span>
                          <span>{formatDateTime(comment.createdAt)}</span>
                        </div>
                        <p className="mt-2 text-sm text-foreground">{comment.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {taskQuery.data.workflowOrigin.latestRun ? (
                <div className="rounded-lg border border-border/60 bg-background/30 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    Latest Workflow Run
                  </div>
                  <p className="mt-2 text-sm font-medium text-foreground">
                    {taskQuery.data.workflowOrigin.workflow?.label ?? "Workflow run"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {labelizeStatus(taskQuery.data.workflowOrigin.latestRun.status)} · {formatDateTime(taskQuery.data.workflowOrigin.latestRun.createdAt)}
                  </p>
                  {taskQuery.data.workflowOrigin.latestRun.failureReason ? (
                    <p className="mt-2 text-sm text-destructive">{taskQuery.data.workflowOrigin.latestRun.failureReason}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
