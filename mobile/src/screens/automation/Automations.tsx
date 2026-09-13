import { ArrowRight, CaretDown, CaretUp, Lightning, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { fetchAutomationImpact, fetchWorkflowDetail, fetchWorkflows, updateWorkflowStatus, type WorkflowListRow, type WorkflowsListResponse } from "@m/lib/api";
import { TONE, durationLabel, humanize, relAgo, runTone } from "@m/lib/format";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, QueryView, Skeletons, Switch } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

export function Automations() {
  const scope = useScope();
  const nav = useNav();
  const key = ["automations", "workflows", scope.orgId, scope.companyId];

  const impact = useQuery({ queryKey: ["dashboard", "impact", scope.orgId], queryFn: () => fetchAutomationImpact(scope.orgId) });
  const workflows = useQuery({ queryKey: key, queryFn: () => fetchWorkflows(scope.orgId, { ...scope.scopeParams, pageSize: 100 }) });

  const rate = impact.data ? (impact.data.successRate <= 1 ? impact.data.successRate * 100 : impact.data.successRate) : null;
  const rows = (workflows.data?.rows.items ?? []).filter((w) => w.status !== "archived");

  return (
    <Screen
      title="Automations"
      onRefresh={() => Promise.all([impact.refetch(), workflows.refetch()])}
      trailing={<Btn variant="tinted" tone="vio" size="sm" icon={Plus} onClick={() => nav.push({ name: "builder" })} style={{ marginRight: 4 }}>Build</Btn>}
    >
      {impact.data ? (
        <div className="grid2" style={{ gap: 9 }}>
          {[
            { label: "Time saved", value: durationLabel(impact.data.estimatedTimeSavedSeconds), tone: "pri" as const },
            { label: "Tasks automated", value: String(impact.data.tasksAutoCreated), tone: "vio" as const },
            { label: "Success rate", value: rate === null ? "—" : `${rate.toFixed(1)}%`, tone: "suc" as const },
            { label: "Failed jobs", value: String(impact.data.failedJobsCount), tone: impact.data.failedJobsCount ? ("dest" as const) : ("neutral" as const) },
          ].map((tile) => (
            <div key={tile.label} className="mini">
              <div className="label">{tile.label}</div>
              <div className="value" style={{ fontSize: 21, color: TONE[tile.tone].fg }}>{tile.value}</div>
            </div>
          ))}
        </div>
      ) : (
        <Skeletons count={1} />
      )}

      <QueryView
        query={workflows}
        isEmpty={() => rows.length === 0}
        empty={<Empty icon={Lightning} title="No workflows yet" body="Automations run on triggers like a new lead or a completed booking." action={<Btn variant="tinted" tone="vio" size="sm" onClick={() => nav.push({ name: "builder" })}>Build one</Btn>} />}
      >
        {() => (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {rows.map((workflow) => (
              <WorkflowCard key={workflow.id} workflow={workflow} listKey={key} />
            ))}
          </div>
        )}
      </QueryView>
    </Screen>
  );
}

function WorkflowCard({ workflow, listKey }: { workflow: WorkflowListRow; listKey: unknown[] }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const on = workflow.status === "active";

  const detail = useQuery({
    queryKey: ["automations", "workflow", scope.orgId, workflow.id],
    queryFn: () => fetchWorkflowDetail(scope.orgId, workflow.id),
    enabled: expanded,
  });

  const toggle = useMutation({
    mutationFn: (next: boolean) => updateWorkflowStatus(scope.orgId, workflow.id, next ? "active" : "paused"),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<WorkflowsListResponse>(listKey);
      queryClient.setQueryData<WorkflowsListResponse>(listKey, (old) =>
        old ? { ...old, rows: { ...old.rows, items: old.rows.items.map((w) => (w.id === workflow.id ? { ...w, status: next ? "active" : "paused" } : w)) } } : old,
      );
      return { previous };
    },
    onError: (error, _next, ctx) => {
      queryClient.setQueryData(listKey, ctx?.previous);
      toast(error instanceof Error ? error.message : "Couldn't update workflow", "error");
    },
    onSuccess: (_d, next) => toast(next ? "Workflow active" : "Workflow paused"),
  });

  const tint = on ? "vio" : "neutral";
  const meta = [scope.companyId ? null : workflow.company?.name, workflow.recentRunSummary.lastRunAt ? `last run ${relAgo(workflow.recentRunSummary.lastRunAt)}` : humanize(workflow.status)].filter(Boolean).join(" · ");

  return (
    <div className="card" style={{ padding: "13px 14px", display: "flex", flexDirection: "column", gap: 11, borderColor: on ? undefined : "var(--divider)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="icon-box" style={{ background: TONE[tint].bg, color: TONE[tint].fg }}>
          <Lightning size={15} weight="fill" />
        </span>
        <button type="button" onClick={() => setExpanded((e) => !e)} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: 0, padding: 0 }}>
          <span className="row-title">{workflow.name}</span>
          <span className="row-sub">{meta}</span>
        </button>
        <Switch on={on} label={on ? "Pause workflow" : "Activate workflow"} disabled={workflow.status === "draft" && !on && false} onChange={(next) => toggle.mutate(next)} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span className="meta-chip">{humanize(workflow.triggerType)}</span>
        <ArrowRight size={10} color="hsl(220 10% 35%)" />
        <span className="meta-chip">{workflow.metrics.totalRuns.toLocaleString()} runs</span>
        {workflow.metrics.failedRuns ? <span style={{ font: "600 10px/1 Inter, sans-serif", color: "var(--dest-l)" }}>{workflow.metrics.failedRuns} failed</span> : null}
        <button type="button" className="link-btn" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, color: TONE[tint].fg }} onClick={() => setExpanded((e) => !e)}>
          Runs {expanded ? <CaretUp size={10} /> : <CaretDown size={10} />}
        </button>
      </div>
      {expanded ? (
        detail.isPending ? (
          <Skeletons count={1} />
        ) : (detail.data?.workflowRuns.items ?? []).length === 0 ? (
          <span className="fine">No runs yet.</span>
        ) : (
          <div className="list" style={{ borderRadius: 11 }}>
            {detail.data!.workflowRuns.items.slice(0, 5).map((run) => (
              <button key={run.id} type="button" className="row" style={{ padding: "10px 12px" }} onClick={() => nav.push({ name: "run", runId: run.id })}>
                <span className="dot" style={{ width: 8, height: 8, background: TONE[runTone(run.status)].solid }} />
                <span className="grow">
                  <span className="row-title" style={{ fontSize: 12 }}>{run.triggerEvent?.label ?? humanize(run.status)}</span>
                  <span className="row-sub">{run.failureReason ?? `${run.actionsExecutedCount} actions · ${relAgo(run.createdAt)}`}</span>
                </span>
              </button>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
