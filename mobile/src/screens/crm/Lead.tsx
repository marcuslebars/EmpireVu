import {
  ChatCircle,
  EnvelopeSimple,
  FileText,
  PaperPlaneRight,
  Phone,
  PhoneOutgoing,
  Sparkle,
  type Icon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  analyzeContactAI,
  fetchContactAIDrafts,
  fetchContactDetail,
  fetchConversationThread,
  markContactRead,
  sendAIDraft,
  sendContactMessage,
  updateAIDraft,
  updateContactStage,
  type AIDraft,
  type ConversationThreadItem,
} from "@m/lib/api";
import { TONE, initials, relAgo, stageTone } from "@m/lib/format";
import { openMail, openSms, openTel, success } from "@m/lib/native";
import { useNav } from "@m/state/nav";
import { useScope } from "@m/state/scope";
import { Screen } from "@m/ui/Screen";
import { Btn, Empty, ErrorBanner, Pills, Section, Skeletons, Tag, TextArea } from "@m/ui/kit";
import { useToast } from "@m/ui/toast";

type Stage = "lead" | "qualified" | "active" | "closed";
const STAGES: Array<{ value: Stage; label: string }> = [
  { value: "lead", label: "Lead" },
  { value: "qualified", label: "Qualified" },
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
];

export function ActionGrid({ actions }: { actions: Array<{ label: string; icon: Icon; tone: "suc" | "pri" | "warn" | "vio"; onClick: () => void; disabled?: boolean }> }) {
  return (
    <div className="grid4">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={action.disabled}
          onClick={action.onClick}
          style={{ height: 64, borderRadius: 13, border: "1px solid var(--border)", background: "hsl(222 16% 12%)", color: TONE[action.tone].fg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5 }}
        >
          <action.icon size={19} weight="fill" />
          <span style={{ font: "600 10px/1 Inter, sans-serif", color: "hsl(220 10% 74%)" }}>{action.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Lead detail: the conversation, Marina's drafted reply, stage and the quote CTA. */
export function Lead({ contactId }: { contactId: string }) {
  const scope = useScope();
  const nav = useNav();
  const toast = useToast();
  const queryClient = useQueryClient();

  const detail = useQuery({ queryKey: ["crm", "contact", scope.orgId, contactId], queryFn: () => fetchContactDetail(scope.orgId, contactId) });
  const thread = useQuery({ queryKey: ["inbox", "thread", scope.orgId, contactId], queryFn: () => fetchConversationThread(scope.orgId, contactId, { limit: 50 }) });
  const drafts = useQuery({ queryKey: ["ai-drafts", scope.orgId, contactId], queryFn: () => fetchContactAIDrafts(scope.orgId, contactId) });

  useEffect(() => {
    void markContactRead(scope.orgId, contactId)
      .then(() => queryClient.invalidateQueries({ queryKey: ["inbox", scope.orgId] }))
      .catch(() => undefined);
  }, [scope.orgId, contactId, queryClient]);

  const stage = useMutation({
    mutationFn: (next: Stage) => updateContactStage(scope.orgId, contactId, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["crm", "contact", scope.orgId, contactId] });
      const previous = queryClient.getQueryData(["crm", "contact", scope.orgId, contactId]);
      queryClient.setQueryData(["crm", "contact", scope.orgId, contactId], (old: typeof detail.data) => (old ? { ...old, contact: { ...old.contact, stage: next } } : old));
      return { previous };
    },
    onError: (error, _next, ctx) => {
      queryClient.setQueryData(["crm", "contact", scope.orgId, contactId], ctx?.previous);
      toast(error instanceof Error ? error.message : "Couldn't change stage", "error");
    },
    onSuccess: (_data, next) => {
      toast(`Stage → ${STAGES.find((s) => s.value === next)?.label}`);
      void queryClient.invalidateQueries({ queryKey: ["crm"] });
    },
  });

  const contact = detail.data?.contact;
  const refresh = () => Promise.all([detail.refetch(), thread.refetch(), drafts.refetch()]);

  return (
    <Screen title={contact?.name ?? "Lead"} onRefresh={refresh}>
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
              <div className="sub" style={{ marginTop: 3 }}>{[contact!.phone, contact!.email].filter(Boolean).join(" · ") || "No contact details"}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <Tag tone={stageTone(contact!.stage)}>{contact!.stage}</Tag>
                {contact!.company ? <Tag>{contact!.company.name}</Tag> : null}
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

          <DraftCard contactId={contactId} drafts={drafts.data} loading={drafts.isPending} hasPhone={Boolean(contact!.phone)} hasEmail={Boolean(contact!.email)} />

          <Section title="Conversation">
            {thread.isPending ? (
              <Skeletons count={2} />
            ) : thread.isError ? (
              <ErrorBanner error={thread.error} onRetry={() => void thread.refetch()} />
            ) : (thread.data ?? []).length === 0 ? (
              <Empty icon={ChatCircle} title="No conversation yet" body="Calls, texts and emails with this lead appear here." />
            ) : (
              <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {[...thread.data!].reverse().map((item) => (
                  <ThreadItem key={item.id} item={item} name={contact!.name} />
                ))}
              </div>
            )}
          </Section>

          <Composer contactId={contactId} hasPhone={Boolean(contact!.phone)} hasEmail={Boolean(contact!.email)} />

          <Section title="Move stage">
            <Pills options={STAGES} value={(contact!.stage as Stage) ?? "lead"} onChange={(next) => next !== contact!.stage && stage.mutate(next)} size="fill" />
          </Section>

          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="tinted" tone="vio" size="md" flex icon={PhoneOutgoing} iconWeight="fill" disabled={!contact!.phone} onClick={() => nav.push({ name: "call", contactId, calleeName: contact!.name })}>
              Marina call
            </Btn>
            <Btn variant="tinted" tone="pri" size="md" flex icon={FileText} onClick={() => nav.push({ name: "quote", contactId })}>
              Build a quote
            </Btn>
          </div>
        </>
      )}
    </Screen>
  );
}

function ThreadItem({ item, name }: { item: ConversationThreadItem; name: string }) {
  const outbound = item.direction === "outbound";
  const who = item.kind === "draft" ? "Draft" : outbound ? "You" : name.split(" ")[0] ?? "Lead";
  const tint = item.kind === "call" ? "var(--vio-l)" : outbound ? "var(--pri-l)" : "var(--fg3)";
  const label = item.kind === "call" ? "Call" : item.channel ? item.channel.toUpperCase() : item.kind;
  return (
    <div style={{ display: "flex", gap: 9 }}>
      <span style={{ font: "700 9px/1.6 Inter, sans-serif", textTransform: "uppercase", letterSpacing: ".09em", color: tint, width: 52, flex: "none" }}>{who}</span>
      <span className="grow">
        {item.title ? <span style={{ display: "block", font: "600 12px/1.4 Inter, sans-serif", color: "hsl(220 10% 86%)" }}>{item.title}</span> : null}
        {item.body ? <span style={{ display: "block", font: "400 12.5px/1.55 Inter, sans-serif", color: "hsl(220 10% 74%)", whiteSpace: "pre-wrap" }}>{item.body}</span> : null}
        <span style={{ display: "block", font: "400 10px/1 Inter, sans-serif", color: "hsl(220 10% 42%)", marginTop: 5 }}>
          {label} · {relAgo(item.occurred_at)}
          {item.status && item.status !== "sent" && item.status !== "delivered" ? ` · ${item.status}` : ""}
        </span>
      </span>
    </div>
  );
}

function DraftCard({ contactId, drafts, loading, hasPhone, hasEmail }: { contactId: string; drafts: AIDraft[] | undefined; loading: boolean; hasPhone: boolean; hasEmail: boolean }) {
  const scope = useScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const draft = (drafts ?? []).find((d) => (d.sms_status === "draft" && d.sms_body) || (d.email_status === "draft" && d.email_body)) ?? null;
  const channel: "sms" | "email" = draft?.sms_body && draft.sms_status === "draft" && hasPhone ? "sms" : "email";
  const body = channel === "sms" ? draft?.sms_body ?? "" : draft?.email_body ?? "";
  const [text, setText] = useState(body);
  useEffect(() => setText(body), [body]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["ai-drafts", scope.orgId, contactId] });
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
  };

  const analyze = useMutation({
    mutationFn: () => analyzeContactAI(scope.orgId, contactId),
    onSuccess: invalidate,
    onError: (error) => toast(error instanceof Error ? error.message : "Marina couldn't draft a reply", "error"),
  });
  const send = useMutation({
    mutationFn: async () => {
      if (editing && text !== body) {
        await updateAIDraft(scope.orgId, contactId, draft!.id, channel === "sms" ? { smsBody: text } : { emailBody: text });
      }
      return sendAIDraft(scope.orgId, contactId, draft!.id, channel);
    },
    onSuccess: () => {
      success();
      setEditing(false);
      toast(channel === "sms" ? "Text sent" : "Email sent");
      invalidate();
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Send failed", "error"),
  });

  if (loading) return null;

  if (!draft) {
    return (
      <Btn variant="tinted" tone="vio" size="md" icon={Sparkle} iconWeight="fill" loading={analyze.isPending} disabled={!hasPhone && !hasEmail} onClick={() => analyze.mutate()}>
        Draft a reply with Marina
      </Btn>
    );
  }

  return (
    <div style={{ borderRadius: 16, border: "1px solid hsl(252 80% 62% / .3)", background: "hsl(252 80% 62% / .06)", padding: 15, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Sparkle weight="fill" size={15} color="hsl(252 80% 70%)" />
        <span style={{ font: "700 12px/1 Inter, sans-serif" }}>Drafted {channel === "sms" ? "text" : "email"}</span>
        <span style={{ marginLeft: "auto", font: "500 10px/1 Inter, sans-serif", color: "var(--mut)" }}>Claude · {relAgo(draft.updated_at)}</span>
      </div>
      {editing ? (
        <TextArea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p style={{ margin: 0, font: "400 13px/1.6 Inter, sans-serif", color: "hsl(220 10% 80%)", whiteSpace: "pre-wrap" }}>{body}</p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn flex loading={send.isPending} disabled={!text.trim()} onClick={() => send.mutate()}>
          Approve &amp; send
        </Btn>
        <Btn variant="secondary" onClick={() => setEditing((e) => !e)}>
          {editing ? "Done" : "Edit"}
        </Btn>
      </div>
    </div>
  );
}

function Composer({ contactId, hasPhone, hasEmail }: { contactId: string; hasPhone: boolean; hasEmail: boolean }) {
  const scope = useScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<"sms" | "email">(hasPhone ? "sms" : "email");
  const [body, setBody] = useState("");

  const send = useMutation({
    mutationFn: () => sendContactMessage(scope.orgId, contactId, { channel, body: body.trim(), subject: channel === "email" ? "Following up" : undefined }),
    onSuccess: (result) => {
      if (result.status === "sent") {
        success();
        setBody("");
        toast(channel === "sms" ? "Text sent" : "Email sent");
      } else {
        toast(result.reason ?? (result.status === "blocked" ? "This contact has opted out" : "Send failed"), "error");
      }
      void queryClient.invalidateQueries({ queryKey: ["inbox", "thread", scope.orgId, contactId] });
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Send failed", "error"),
  });

  if (!hasPhone && !hasEmail) return null;

  return (
    <div className="card pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {hasPhone && hasEmail ? <Pills options={[{ value: "sms", label: "Text" }, { value: "email", label: "Email" }]} value={channel} onChange={setChannel} /> : null}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <TextArea rows={2} placeholder={channel === "sms" ? "Write a text…" : "Write an email…"} value={body} onChange={(e) => setBody(e.target.value)} />
        <button
          type="button"
          aria-label="Send"
          disabled={!body.trim() || send.isPending}
          onClick={() => send.mutate()}
          style={{ width: 44, height: 44, flex: "none", borderRadius: 11, border: 0, background: "var(--pri)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          {send.isPending ? <span className="spinner" /> : <PaperPlaneRight size={16} weight="fill" />}
        </button>
      </div>
    </div>
  );
}
