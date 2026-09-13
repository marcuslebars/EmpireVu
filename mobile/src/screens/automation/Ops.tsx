import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchOpsJobsHealth, fetchOpsWorkflowRuns, fetchWorkflowJobs, retryWorkflowJob } from "@m/lib/api";
import { TONE, humanize, relAgo, runTone } from "@m/lib/format";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, ErrorBanner, Section, Skeletons } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

export function Ops() {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();

  const health = useQuery({ queryKey: ["ops", "health", scope.orgId, scope.companyId], queryFn: () => fetchOpsJobsHealth(scope.orgId, scope.scopeParams) });
  const runs = useQuery({ queryKey: ["ops", "runs", scope.orgId, scope.companyId], queryFn: () => fetchOpsWorkflowRuns(scope.orgId, { ...scope.scopeParams, limit: 30 }) });
  const failed = useQuery({ queryKey: ["ops", "failed-jobs", scope.orgId, scope.companyId], queryFn: () => fetchWorkflowJobs(scope.orgId, { ...scope.scopeParams, status: "failed", pageSize: 50 }) });

  const retryable = (failed.data?.rows.items ?? []).filter((job) => job.retryEligible);
  const retry = useMutation({
    mutationFn: async () => {
      for (const job of retryable) await retryWorkflowJob(scope.orgId, job.id);
      return retryable.length;
    },
    onSuccess: (count) => {
      toast(`${count} job${count === 1 ? "" : "s"} re-queued`);
      void queryClient.invalidateQueries({ queryKey: ["ops"] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Retry failed", "error"),
  });

  const h = health.data;

  return (
    <Screen title="Workflow Ops" onRefresh={() => Promise.all([health.refetch(), runs.refetch(), failed.refetch()])}>
      <p className="fine" style={{ fontSize: 12 }}>Internal — the workflow event queue and its recent runs{scope.company ? ` for ${scope.company.name}` : ""}.</p>

      {health.isError ? (
        <ErrorBanner error={health.error} onRetry={() => void health.refetch()} />
      ) : !h ? (
        <Skeletons count={1} />
      ) : (
        <div className="grid2" style={{ gap: 9 }}>
          {[
            { label: "Pending jobs", value: h.pendingCount, tone: "pri" as const },
            { label: "Processing", value: h.runningCount, tone: "warn" as const },
            { label: "Failed", value: h.failedCount, tone: h.failedCount ? ("dest" as const) : ("neutral" as const) },
            { label: "Stuck running", value: h.suspiciousRunningCount, tone: h.suspiciousRunningCount ? ("warn" as const) : ("neutral" as const) },
          ].map((tile) => (
            <div key={tile.label} className="mini" style={{ borderColor: tile.tone === "dest" ? TONE.dest.border : undefined }}>
              <div className="label" style={{ fontSize: 9.5 }}>{tile.label}</div>
              <div className="value" style={{ color: TONE[tile.tone].fg }}>{tile.value}</div>
            </div>
          ))}
        </div>
      )}

      <Section title="Recent runs">
        {runs.isPending ? (
          <Skeletons count={2} />
        ) : runs.isError ? (
          <ErrorBanner error={runs.error} onRetry={() => void runs.refetch()} />
        ) : (runs.data ?? []).length === 0 ? (
          <Empty title="No runs yet" body="Workflow runs in this scope appear here." />
        ) : (
          <div className="list">
            {runs.data!.map((run) => (
              <button key={run.id} type="button" className="row" style={{ padding: "12px 14px" }} onClick={() => nav.push({ name: "run", runId: run.id })}>
                <span className="dot" style={{ width: 8, height: 8, background: TONE[runTone(run.status)].solid }} />
                <span className="grow">
                  <span className="ellipsis" style={{ display: "block", font: "500 12px/1.3 Inter, sans-serif", color: "hsl(220 10% 88%)" }}>{run.workflowName ?? "Workflow"}</span>
                  <span className="mono" style={{ display: "block", font: "400 10px/1 ui-monospace, Menlo, monospace", color: "var(--faint)", marginTop: 5 }}>
                    {run.id.slice(0, 8)} · {relAgo(run.createdAt)}
                  </span>
                </span>
                <span className="num" style={{ font: "600 10px/1 Inter, sans-serif", color: TONE[runTone(run.status)].fg, flex: "none" }}>{humanize(run.status)}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Btn
        variant={retryable.length ? "tinted" : "secondary"}
        tone="dest"
        size="md"
        disabled={retryable.length === 0}
        loading={retry.isPending}
        onClick={() => retry.mutate()}
      >
        {retryable.length ? `Retry ${retryable.length} failed job${retryable.length === 1 ? "" : "s"}` : "No failed jobs to retry"}
      </Btn>
    </Screen>
  );
}
