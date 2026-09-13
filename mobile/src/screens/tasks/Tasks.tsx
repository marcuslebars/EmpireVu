import { CheckCircle, Microphone } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { fetchTasks, updateTaskStatus, type TaskListRow, type TasksListResponse } from "@m/lib/api";
import { TONE, dueLabel, priorityTone } from "@m/lib/format";
import { success, tap } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { useSession } from "@m/state/session";
import { Screen } from "@m/ui/Screen";
import { Btn, CheckBox, Empty, Pills, QueryView, Tag } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

type Filter = "Open" | "Mine" | "Urgent" | "Blocked" | "Done";

export function Tasks() {
  const scope = useScope();
  const nav = useNav();
  const session = useSession();
  const [filter, setFilter] = useState<Filter>("Open");
  const profileId = session.context.data?.profile?.id;

  const params = {
    ...scope.scopeParams,
    pageSize: 100,
    ...(filter === "Mine" && profileId ? { assigneeId: profileId } : {}),
    ...(filter === "Blocked" ? { status: "blocked" } : {}),
    ...(filter === "Done" ? { status: "completed" } : {}),
  };
  const key = ["tasks", scope.orgId, scope.companyId, filter];
  const query = useQuery({ queryKey: key, queryFn: () => fetchTasks(scope.orgId, params) });

  const rows = (query.data?.rows.items ?? []).filter((task) => {
    if (filter === "Done" || filter === "Blocked") return true;
    if (task.status === "completed") return false;
    if (filter === "Urgent") return task.priority === "urgent" || task.priority === "high";
    return true;
  });

  return (
    <Screen root onRefresh={() => query.refetch()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="h1">Tasks</div>
        <Btn variant="tinted" tone="vio" size="sm" icon={Microphone} iconWeight="fill" onClick={() => nav.openSheet({ id: "voiceNote" })}>
          Voice
        </Btn>
      </div>
      <Pills options={["Open", "Mine", "Urgent", "Blocked", "Done"] as const} value={filter} onChange={setFilter} />
      <QueryView
        query={query}
        isEmpty={() => rows.length === 0}
        empty={<Empty icon={CheckCircle} iconTone="suc" title="Nothing here" body="No tasks match this filter." />}
      >
        {() => (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {rows.map((task) => (
              <TaskRow key={task.id} task={task} queryKey={key} />
            ))}
          </div>
        )}
      </QueryView>
    </Screen>
  );
}

function TaskRow({ task, queryKey }: { task: TaskListRow; queryKey: unknown[] }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const done = task.status === "completed";

  const toggle = useMutation({
    mutationFn: () => updateTaskStatus(scope.orgId, task.id, done ? "todo" : "completed"),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TasksListResponse>(queryKey);
      queryClient.setQueryData<TasksListResponse>(queryKey, (old) =>
        old ? { ...old, rows: { ...old.rows, items: old.rows.items.map((t) => (t.id === task.id ? { ...t, status: done ? "todo" : "completed" } : t)) } } : old,
      );
      return { previous };
    },
    onError: (error, _v, ctx) => {
      queryClient.setQueryData(queryKey, ctx?.previous);
      toast(error instanceof Error ? error.message : "Couldn't update task", "error");
    },
    onSuccess: () => {
      if (!done) success();
      toast(done ? "Reopened" : "Task completed");
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const overdue = task.isOverdue && !done;
  const context = [task.contact?.name, task.booking?.label, scope.companyId ? null : task.company?.name].filter(Boolean).join(" · ");

  return (
    <div className="card" style={{ padding: "13px 14px", display: "flex", gap: 12, alignItems: "flex-start", borderColor: overdue && task.priority === "urgent" ? "hsl(0 72% 51% / .26)" : undefined }}>
      <span style={{ marginTop: 1 }}>
        <CheckBox on={done} onChange={() => toggle.mutate()} label={done ? "Reopen task" : "Complete task"} />
      </span>
      <button type="button" onClick={() => { tap(); nav.push({ name: "task", taskId: task.id }); }} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: 0, padding: 0 }}>
        <span style={{ display: "block", font: "600 13.5px/1.35 Inter, sans-serif", letterSpacing: "-.01em", color: done ? "hsl(220 10% 42%)" : "hsl(220 10% 92%)", textDecoration: done ? "line-through" : "none" }}>{task.title}</span>
        {context ? <span style={{ display: "block", font: "400 11.5px/1.4 Inter, sans-serif", color: "var(--mut)", marginTop: 4 }}>{context}</span> : null}
        <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9, flexWrap: "wrap" }}>
          <Tag tone={priorityTone(task.priority)}>{task.priority}</Tag>
          <span style={{ font: "500 10px/1 Inter, sans-serif", color: overdue ? TONE.dest.fg : task.status === "blocked" ? "var(--fg3)" : "hsl(220 10% 50%)" }}>
            {task.status === "blocked" ? "Blocked" : done ? "Done" : dueLabel(task.dueAt, task.isOverdue)}
          </span>
          {task.assignee ? <span style={{ font: "500 10px/1 Inter, sans-serif", color: "hsl(220 10% 45%)" }}>{task.assignee.name}</span> : null}
          {task.workflow ? <Tag tone="vio">auto</Tag> : null}
        </span>
      </button>
    </div>
  );
}
