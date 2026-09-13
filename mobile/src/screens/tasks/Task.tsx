import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchTaskDetail, updateTaskStatus, type TaskDetailResponse } from "@m/lib/api";
import { dueLabel, humanize, priorityTone, relAgo, shortDate } from "@m/lib/format";
import { success } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { CommentsSection } from "@m/ui/Comments";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, KeyValueRows, Pills, Section, Skeletons, Tag } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

type Status = "todo" | "in_progress" | "blocked" | "completed";
const STATUSES: Array<{ value: Status; label: string }> = [
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "completed", label: "Done" },
];

export function Task({ taskId }: { taskId: string }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["tasks", "detail", scope.orgId, taskId];

  const detail = useQuery({ queryKey: key, queryFn: () => fetchTaskDetail(scope.orgId, taskId) });

  const status = useMutation({
    mutationFn: (next: Status) => updateTaskStatus(scope.orgId, taskId, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<TaskDetailResponse>(key);
      queryClient.setQueryData<TaskDetailResponse>(key, (old) => (old ? { ...old, task: { ...old.task, status: next } } : old));
      return { previous };
    },
    onError: (error, _next, ctx) => {
      queryClient.setQueryData(key, ctx?.previous);
      toast(error instanceof Error ? error.message : "Couldn't update task", "error");
    },
    onSuccess: (_d, next) => {
      if (next === "completed") success();
      toast(`Status → ${STATUSES.find((s) => s.value === next)?.label}`);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const data = detail.data;
  const task = data?.task;
  const links = data?.linkedEntities;
  const origin = data?.workflowOrigin;

  return (
    <Screen title="Task" onRefresh={() => detail.refetch()}>
      {detail.isPending ? (
        <Skeletons count={3} />
      ) : detail.isError ? (
        <ErrorBanner error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <>
          <div>
            <div style={{ font: "700 19px/1.3 Inter, sans-serif", letterSpacing: "-.02em" }}>{task!.title}</div>
            <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap" }}>
              <Tag tone={priorityTone(task!.priority)} style={{ padding: "6px 9px" }}>{task!.priority}</Tag>
              <Tag style={{ padding: "6px 9px" }}>{humanize(task!.status)}</Tag>
              {origin?.workflow ? <Tag tone="vio" style={{ padding: "6px 9px" }}>Auto-created</Tag> : null}
            </div>
          </div>

          <Pills options={STATUSES} value={task!.status as Status} onChange={(next) => next !== task!.status && status.mutate(next)} size="fill" />

          {task!.description ? <p className="body" style={{ whiteSpace: "pre-wrap" }}>{task!.description}</p> : null}

          <KeyValueRows
            rows={[
              { k: "Due", v: task!.dueAt ? `${dueLabel(task!.dueAt, task!.isOverdue)} · ${shortDate(task!.dueAt)}` : "No due date" },
              { k: "Assignee", v: task!.assignee?.name ?? "Unassigned" },
              {
                k: "Contact",
                v: links?.contact ? (
                  <button type="button" className="link-btn" style={{ padding: 0, fontSize: 12.5 }} onClick={() => nav.push({ name: "contact", contactId: links.contact!.id })}>
                    {links.contact.name}
                  </button>
                ) : (
                  "—"
                ),
              },
              {
                k: "Booking",
                v: links?.booking ? (
                  <button type="button" className="link-btn" style={{ padding: 0, fontSize: 12.5 }} onClick={() => nav.push({ name: "booking", bookingId: links.booking!.id })}>
                    {links.booking.label}
                  </button>
                ) : (
                  "—"
                ),
              },
              { k: "Company", v: links?.company?.name ?? "—" },
            ]}
          />

          {origin?.workflow ? (
            <Section title="Why this exists">
              <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                <p className="body">
                  Workflow <span style={{ color: "hsl(252 80% 74%)", fontWeight: 600 }}>{origin.workflow.label}</span> created this task
                  {origin.latestRun ? ` ${relAgo(origin.latestRun.createdAt)}` : ""}.
                </p>
                {origin.latestRun ? (
                  <Btn variant="secondary" onClick={() => nav.push({ name: "run", runId: origin.latestRun!.id })}>
                    View workflow run
                  </Btn>
                ) : null}
              </div>
            </Section>
          ) : null}

          <CommentsSection comments={data!.comments} entityType="task" entityId={taskId} companyId={links?.company?.id} invalidateKey={key} />
        </>
      )}
    </Screen>
  );
}
