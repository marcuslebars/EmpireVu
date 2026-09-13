import {
  CalendarCheck,
  ChatCircle,
  CheckSquare,
  EnvelopeSimple,
  FileText,
  Lightning,
  Phone,
  PhoneOutgoing,
  Plus,
  Scales,
  TrendUp,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { activityPresentation } from "@m/lib/activity";
import { fetchContactDetail, updateContactNotes } from "@m/lib/api";
import { TONE, bookingTone, dueLabel, humanize, initials, money, priorityTone, quoteTone, relAgo, runTone, shortDate, stageTone, timeHM, type Tone } from "@m/lib/format";
import { openMail, openSms, openTel } from "@m/lib/native";
import { ActionGrid } from "@m/screens/crm/Lead";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { CommentsSection } from "@m/ui/Comments";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, ErrorBanner, IconBox, Pills, Skeletons, Tag, TextArea } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

const TABS = ["Activity", "Bookings", "Tasks", "Quotes", "Comments", "Financials", "Workflows", "Notes"] as const;
type TabName = (typeof TABS)[number];

function TimelineCard({ icon, tone, label, detail, when, onClick }: { icon: typeof Phone; tone: Tone; label: ReactNode; detail?: ReactNode; when?: ReactNode; onClick?: () => void }) {
  const inner = (
    <>
      <IconBox icon={icon} tone={tone} size={28} fill tinted />
      <span className="grow">
        <span style={{ display: "block", font: "600 12.5px/1.35 Inter, sans-serif", color: "hsl(220 10% 88%)" }}>{label}</span>
        {detail ? <span style={{ display: "block", font: "400 11.5px/1.45 Inter, sans-serif", color: "hsl(220 10% 55%)", marginTop: 4 }}>{detail}</span> : null}
        {when ? <span style={{ display: "block", font: "400 10px/1 Inter, sans-serif", color: "var(--faint)", marginTop: 6 }}>{when}</span> : null}
      </span>
    </>
  );
  const style = { display: "flex", gap: 11, borderRadius: 13, padding: "12px 13px", textAlign: "left" as const, width: "100%" };
  return onClick ? (
    <button type="button" className="card" style={style} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="card" style={style}>
      {inner}
    </div>
  );
}

export function Contact({ contactId }: { contactId: string }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabName>("Activity");
  const key = ["crm", "contact", scope.orgId, contactId];

  const detail = useQuery({ queryKey: key, queryFn: () => fetchContactDetail(scope.orgId, contactId) });
  const data = detail.data;
  const contact = data?.contact;

  const [notes, setNotes] = useState("");
  useEffect(() => setNotes(contact?.notes ?? ""), [contact?.notes]);
  const saveNotes = useMutation({
    mutationFn: () => updateContactNotes(scope.orgId, contactId, notes.trim() || null),
    onSuccess: () => {
      toast("Notes saved");
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't save notes", "error"),
  });

  const empty = (title: string, body: string) => <Empty title={title} body={body} />;

  return (
    <Screen title={contact?.name ?? "Contact"} onRefresh={() => detail.refetch()}>
      {detail.isPending ? (
        <Skeletons count={3} />
      ) : detail.isError ? (
        <ErrorBanner error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <>
          <div style={{ display: "flex", gap: 13, alignItems: "center" }}>
            <span className="avatar lg">{initials(contact!.name)}</span>
            <div className="grow">
              <div className="h3">{contact!.name}</div>
              <div className="sub" style={{ marginTop: 3 }}>{[contact!.company?.name, contact!.phone ?? contact!.email].filter(Boolean).join(" · ")}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <Tag tone={stageTone(contact!.stage)}>{contact!.stage}</Tag>
                <Tag>{money(data!.financialSummary.realizedRevenueCents, { compact: true })} lifetime</Tag>
              </div>
            </div>
          </div>

          <ActionGrid
            actions={[
              { label: "Call", icon: Phone, tone: "suc", disabled: !contact!.phone, onClick: () => contact!.phone && openTel(contact!.phone) },
              { label: "Text", icon: ChatCircle, tone: "pri", disabled: !contact!.phone, onClick: () => contact!.phone && openSms(contact!.phone) },
              { label: "Email", icon: EnvelopeSimple, tone: "warn", disabled: !contact!.email, onClick: () => contact!.email && openMail(contact!.email) },
              { label: "Quote", icon: FileText, tone: "vio", onClick: () => nav.push({ name: "quote", contactId }) },
            ]}
          />

          {data!.nextAction.type !== "done" ? (
            <div className="banner" style={{ background: TONE[data!.nextAction.type === "urgent" ? "dest" : "pri"].bg, border: `1px solid ${TONE[data!.nextAction.type === "urgent" ? "dest" : "pri"].border}` }}>
              <span className="grow">
                <span style={{ display: "block", font: "600 12.5px/1.3 Inter, sans-serif" }}>{data!.nextAction.label}</span>
                <span style={{ display: "block", font: "400 11.5px/1.4 Inter, sans-serif", color: "hsl(220 10% 64%)", marginTop: 3 }}>{data!.nextAction.detail}</span>
              </span>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" flex icon={ChatCircle} onClick={() => nav.push({ name: "lead", contactId })}>
              Conversation
            </Btn>
            <Btn variant="tinted" tone="vio" flex icon={PhoneOutgoing} iconWeight="fill" disabled={!contact!.phone} onClick={() => nav.push({ name: "call", contactId, calleeName: contact!.name })}>
              Marina call
            </Btn>
          </div>

          <Pills options={TABS} value={tab} onChange={setTab} />

          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {tab === "Activity" &&
              (data!.timeline.length === 0
                ? empty("No activity yet", "Calls, stage changes and bookings appear here.")
                : data!.timeline.slice(0, 30).map((item) => {
                    const p = activityPresentation(item.kind);
                    return <TimelineCard key={item.id} icon={p.icon} tone={p.tone} label={item.title || p.label} detail={item.detail} when={relAgo(item.occurredAt)} />;
                  }))}

            {tab === "Bookings" && (
              <>
                {data!.linkedBookings.length === 0
                  ? empty("No bookings yet", `Nothing scheduled for ${contact!.name}.`)
                  : data!.linkedBookings.map((b) => (
                      <TimelineCard key={b.id} icon={CalendarCheck} tone={bookingTone(b.status)} label={b.title} detail={`${humanize(b.status)}${b.revenueCents ? ` · ${money(b.revenueCents)}` : ""}`} when={`${shortDate(b.scheduledFor)} · ${timeHM(b.scheduledFor)}`} onClick={() => nav.push({ name: "booking", bookingId: b.id })} />
                    ))}
                <Btn variant="dashed" icon={Plus} onClick={() => nav.push({ name: "newBooking", contactId })}>
                  New booking
                </Btn>
              </>
            )}

            {tab === "Tasks" && (
              <>
                {data!.linkedTasks.length === 0
                  ? empty("No open tasks", `Nothing outstanding for ${contact!.name}.`)
                  : data!.linkedTasks.map((t) => (
                      <TimelineCard key={t.id} icon={CheckSquare} tone={priorityTone(t.priority)} label={t.title} detail={`${humanize(t.priority)} · ${humanize(t.status)}`} when={dueLabel(t.dueAt, t.isOverdue)} onClick={() => nav.push({ name: "task", taskId: t.id })} />
                    ))}
                <Btn variant="dashed" icon={Plus} onClick={() => nav.push({ name: "newTask", contactId })}>
                  New task
                </Btn>
              </>
            )}

            {tab === "Quotes" &&
              (data!.linkedQuotes.length === 0
                ? empty("No quotes yet", "Build one from the Quote action above.")
                : data!.linkedQuotes.map((q) => (
                    <TimelineCard key={q.id} icon={FileText} tone={quoteTone(q.status)} label={`${q.quoteNumber ?? "Draft"} · ${q.title ?? "Quote"}`} detail={`${humanize(q.status)} · ${money(q.totalCents)} · deposit ${money(q.depositCents)}`} when={relAgo(q.createdAt)} onClick={() => nav.push({ name: "quote", quoteId: q.id })} />
                  )))}

            {tab === "Comments" && <CommentsSection comments={data!.comments} entityType="contact" entityId={contactId} companyId={contact!.company?.id} invalidateKey={key} />}

            {tab === "Financials" && (
              <>
                <TimelineCard icon={TrendUp} tone="suc" label="Lifetime value" detail={`${money(data!.financialSummary.realizedRevenueCents)} realized across ${data!.linkedQuotes.length} quote${data!.linkedQuotes.length === 1 ? "" : "s"}`} />
                <TimelineCard icon={CalendarCheck} tone="pri" label="Upcoming" detail={`${money(data!.financialSummary.upcomingRevenueCents)} booked ahead`} />
                <TimelineCard icon={Scales} tone="neutral" label="Pipeline" detail={data!.financialSummary.pipelineValueCents ? `${money(data!.financialSummary.pipelineValueCents)} open` : "Nothing open"} />
              </>
            )}

            {tab === "Workflows" &&
              (data!.workflowTraces.length === 0
                ? empty("No workflow runs", "Automations that touch this contact show up here.")
                : data!.workflowTraces.map((run) => (
                    <TimelineCard key={run.id} icon={Lightning} tone={runTone(run.status)} label={run.workflow?.label ?? "Workflow"} detail={run.failureReason ?? humanize(run.status)} when={relAgo(run.createdAt)} onClick={() => nav.push({ name: "run", runId: run.id })} />
                  )))}

            {tab === "Notes" && (
              <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <TextArea rows={5} placeholder="Gate codes, berth details, preferences…" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <Btn variant="secondary" loading={saveNotes.isPending} disabled={notes === (contact!.notes ?? "")} onClick={() => saveNotes.mutate()}>
                  Save notes
                </Btn>
              </div>
            )}
          </div>
        </>
      )}
    </Screen>
  );
}
