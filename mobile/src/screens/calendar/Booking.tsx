import { Camera, CheckCircle, Lightning, Microphone, Phone, Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchBookingDetail, updateBookingStatus, type BookingDetailResponse } from "@m/lib/api";
import { TONE, bookingTone, dueLabel, humanize, money, priorityTone, runTone, shortDate, timeHM } from "@m/lib/format";
import { openTel, success } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { CommentsSection } from "@m/ui/Comments";
import { Screen } from "@m/ui/Screen";
import { Btn, ErrorBanner, KeyValueRows, Pills, Section, Skeletons, Tag } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

type Status = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
const STATUSES: Array<{ value: Status; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "no_show", label: "No-show" },
  { value: "cancelled", label: "Cancelled" },
];

export function Booking({ bookingId }: { bookingId: string }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["calendar", "booking", scope.orgId, bookingId];

  const detail = useQuery({ queryKey: key, queryFn: () => fetchBookingDetail(scope.orgId, bookingId) });

  const status = useMutation({
    mutationFn: (next: Status) => updateBookingStatus(scope.orgId, bookingId, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<BookingDetailResponse>(key);
      queryClient.setQueryData<BookingDetailResponse>(key, (old) => (old ? { ...old, booking: { ...old.booking, status: next } } : old));
      return { previous };
    },
    onError: (error, _next, ctx) => {
      queryClient.setQueryData(key, ctx?.previous);
      toast(error instanceof Error ? error.message : "Couldn't update booking", "error");
    },
    onSuccess: (_data, next) => {
      if (next === "completed") success();
      toast(next === "completed" ? "Job marked complete" : `Status → ${humanize(next)}`);
      void queryClient.invalidateQueries({ queryKey: ["calendar"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const data = detail.data;
  const booking = data?.booking;

  return (
    <Screen title="Booking" onRefresh={() => detail.refetch()}>
      {detail.isPending ? (
        <Skeletons count={3} />
      ) : detail.isError ? (
        <ErrorBanner error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <>
          <div>
            <div className="h2">{booking!.title}</div>
            <div className="sub" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 5 }}>
              {shortDate(booking!.scheduledFor)} · {timeHM(booking!.scheduledFor)} · {booking!.durationMinutes} min
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Tag tone={bookingTone(booking!.status)} style={{ padding: "6px 9px" }}>{humanize(booking!.status)}</Tag>
            {booking!.company ? <Tag style={{ padding: "6px 9px" }}>{booking!.company.name}</Tag> : null}
          </div>

          <div className="grid2" style={{ gap: 8 }}>
            <Btn variant="secondary" size="md" icon={Phone} disabled={!booking!.contact?.phone} onClick={() => booking!.contact?.phone && openTel(booking!.contact.phone)}>
              Call customer
            </Btn>
            <Btn size="md" icon={Camera} onClick={() => nav.push({ name: "photos", bookingId })}>
              Job photos
            </Btn>
          </div>

          {booking!.description ? <p className="body">{booking!.description}</p> : null}

          <KeyValueRows
            rows={[
              {
                k: "Contact",
                v: booking!.contact ? (
                  <button type="button" className="link-btn" style={{ padding: 0, fontSize: 12.5 }} onClick={() => nav.push({ name: "contact", contactId: booking!.contact!.id })}>
                    {booking!.contact.name}
                  </button>
                ) : (
                  "No contact linked"
                ),
              },
              { k: "Company", v: booking!.company?.name ?? "—" },
              { k: "Value", v: booking!.revenueCents ? `${money(booking!.revenueCents)} CAD` : "—" },
              { k: "Workflow runs", v: String(data!.triggeredWorkflowRuns.length) },
            ]}
          />

          <Section title="Status">
            <Pills options={STATUSES} value={(booking!.status as Status) ?? null} onChange={(next) => next !== booking!.status && status.mutate(next)} size="fill" />
          </Section>

          <Section
            title="Tasks"
            action={
              <button type="button" className="link-btn" onClick={() => nav.push({ name: "newTask", bookingId, contactId: booking!.contact?.id })}>
                <Plus size={11} /> Add
              </button>
            }
          >
            {data!.tasks.length === 0 ? (
              <span className="fine" style={{ fontSize: 12 }}>No tasks on this job.</span>
            ) : (
              <div className="list">
                {data!.tasks.map((task) => (
                  <button key={task.id} type="button" className="row" onClick={() => nav.push({ name: "task", taskId: task.id })}>
                    <span className="grow">
                      <span className="row-title">{task.title}</span>
                      <span className="row-sub">{[humanize(task.status), task.assignee?.name, dueLabel(task.dueAt, false)].filter(Boolean).join(" · ")}</span>
                    </span>
                    <Tag tone={priorityTone(task.priority)}>{task.priority}</Tag>
                  </button>
                ))}
              </div>
            )}
          </Section>

          {data!.triggeredWorkflowRuns.length > 0 ? (
            <Section title="Workflow runs">
              <div className="list">
                {data!.triggeredWorkflowRuns.map((run) => (
                  <button key={run.id} type="button" className="row" onClick={() => nav.push({ name: "run", runId: run.id })}>
                    <Lightning size={15} weight="fill" color={TONE[runTone(run.status)].fg} />
                    <span className="grow">
                      <span className="row-title">{run.workflow?.label ?? "Workflow"}</span>
                      <span className="row-sub">{run.failureReason ?? humanize(run.status)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          ) : null}

          <Btn variant="tinted" tone="vio" size="md" icon={Microphone} iconWeight="fill" onClick={() => nav.openSheet({ id: "voiceNote", bookingId, contactId: booking!.contact?.id })}>
            Voice note → task
          </Btn>

          <CommentsSection comments={data!.comments} entityType="booking" entityId={bookingId} companyId={booking!.company?.id} invalidateKey={key} />

          {booking!.status !== "completed" ? (
            <Btn variant="tinted" tone="suc" size="lg" icon={CheckCircle} loading={status.isPending && status.variables === "completed"} onClick={() => status.mutate("completed")}>
              Mark complete
            </Btn>
          ) : null}
        </>
      )}
    </Screen>
  );
}
