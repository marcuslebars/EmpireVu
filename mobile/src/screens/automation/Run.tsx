import { ArrowCounterClockwise, CheckCircle, Info, Lightning, WarningCircle, XCircle, type Icon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { fetchOpsRunDetail, runWorkflowNow } from "@m/lib/api";
import { TONE, durationLabel, humanize, relAgo, runTone, type Tone } from "@m/lib/format";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, Skeletons } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

const LEVEL: Record<string, { icon: Icon; tone: Tone }> = {
  error: { icon: WarningCircle, tone: "dest" },
  warn: { icon: WarningCircle, tone: "warn" },
  info: { icon: CheckCircle, tone: "suc" },
  debug: { icon: Info, tone: "neutral" },
};

export function Run({ runId }: { runId: string }) {
  const scope = useScope();
  const toast = useToast();
  const run = useQuery({ queryKey: ["automations", "run", scope.orgId, runId], queryFn: () => fetchOpsRunDetail(scope.orgId, runId) });

  const replay = useMutation({
    mutationFn: () => runWorkflowNow(scope.orgId, run.data!.workflowId, { eventId: run.data!.triggerEventId! }),
    onSuccess: () => toast("Run queued again"),
    onError: (error) => toast(error instanceof Error ? error.message : "Replay failed", "error"),
  });

  const data = run.data;
  const started = data ? new Date(data.startedAt ?? data.createdAt).getTime() : 0;
  const totalMs = data?.completedAt && data.startedAt ? new Date(data.completedAt).getTime() - new Date(data.startedAt).getTime() : null;

  return (
    <Screen title="Run trace" onRefresh={() => run.refetch()}>
      {run.isPending ? (
        <Skeletons count={3} />
      ) : run.isError ? (
        <ErrorBanner error={run.error} onRetry={() => void run.refetch()} />
      ) : (
        <>
          <div>
            <div style={{ font: "700 17px/1.3 Inter, sans-serif", letterSpacing: "-.02em" }}>{data!.workflowName ?? "Workflow run"}</div>
            <div className="sub" style={{ marginTop: 4 }}>
              Run {data!.id.slice(0, 8)} · {relAgo(data!.createdAt)} · {humanize(data!.status)}
              {totalMs !== null ? ` · ${totalMs < 1000 ? `${totalMs}ms` : `${(totalMs / 1000).toFixed(1)}s`}` : ""}
            </div>
          </div>

          {data!.failureReason ? <ErrorBanner message={data!.failureReason} /> : null}

          <div>
            <TraceStep icon={Lightning} tone="vio" label="Trigger" detail={data!.companyName ? `Fired for ${data!.companyName}` : "Event received"} ms="0ms" />
            {data!.logs.map((log, index) => {
              const level = LEVEL[log.level] ?? LEVEL.info!;
              const offset = Math.max(0, new Date(log.at).getTime() - started);
              return (
                <TraceStep
                  key={index}
                  icon={level.icon}
                  tone={level.tone}
                  label={log.actionType ? `Action · ${humanize(log.actionType).toLowerCase()}` : log.message}
                  detail={log.actionType ? log.message : undefined}
                  ms={`${offset}ms`}
                />
              );
            })}
            <TraceStep
              icon={data!.status === "failed" ? XCircle : CheckCircle}
              tone={runTone(data!.status)}
              label={data!.status === "failed" ? "Ended" : data!.status === "completed" ? "Completed" : humanize(data!.status)}
              detail={`${data!.actionsExecutedCount} actions · ${data!.createdTasksCount} tasks created · ${durationLabel(data!.timeSavedSeconds)} saved`}
              last
            />
          </div>

          {data!.triggerEventId ? (
            <Btn variant="secondary" size="md" icon={ArrowCounterClockwise} loading={replay.isPending} onClick={() => replay.mutate()}>
              Replay this run
            </Btn>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function TraceStep({ icon: IconCmp, tone, label, detail, ms, last }: { icon: Icon; tone: Tone; label: string; detail?: string; ms?: string; last?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ width: 26, flex: "none", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span style={{ width: 26, height: 26, borderRadius: 9, background: TONE[tone].bg, color: TONE[tone].fg, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <IconCmp size={13} weight="fill" />
        </span>
        {!last ? <span style={{ width: 1, flex: 1, background: "hsl(222 14% 16%)" }} /> : null}
      </span>
      <span style={{ flex: 1, minWidth: 0, paddingBottom: 14 }}>
        <span style={{ display: "block", font: "600 12.5px/1.3 Inter, sans-serif", color: "hsl(220 10% 90%)" }}>{label}</span>
        {detail ? <span style={{ display: "block", font: "400 11.5px/1.45 Inter, sans-serif", color: "hsl(220 10% 50%)", marginTop: 4 }}>{detail}</span> : null}
        {ms ? <span className="num" style={{ display: "inline-block", font: "500 10px/1 Inter, sans-serif", color: "var(--faint)", marginTop: 6 }}>{ms}</span> : null}
      </span>
    </div>
  );
}
