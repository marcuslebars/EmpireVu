import { useMemo, useState } from "react";
import {
  Inbox, Search, MessageSquare, Mail, Phone, Loader2, ChevronDown, ChevronRight, Sparkles, FileText, Activity, Send, Bot,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { useInbox, useConversationThread, useMarkContactRead, useSendContactMessage } from "@/lib/api-hooks";
import { relativeTime } from "@/lib/format";
import { EmptyState, ErrorBanner } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { VoicePanel } from "@/components/contact/VoicePanel";
import { AssistantControl } from "@/components/inbox/AssistantControl";
import { toChronological } from "@/lib/inbox-utils";
import type { ConversationThreadItem, InboxRow } from "@/lib/api-client";

const channelIcon = (channel: string | null) =>
  channel === "voice" ? Phone : channel === "email" ? Mail : channel === "form" ? FileText : MessageSquare;

function prettyEvent(eventType: string): string {
  return eventType.replace(/^contact\.|^quote\./, "").replace(/[._]/g, " ");
}

// ─── Left list ────────────────────────────────────────────────────────────────

function InboxList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: InboxRow[];
  selectedId: string | null;
  onSelect: (row: InboxRow) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState title="No conversations" description="Inbound and outbound messages appear here." />;
  }
  return (
    <div className="divide-y divide-border/50">
      {rows.map((row) => {
        const Icon = channelIcon(row.channel);
        const active = row.contact_id === selectedId;
        return (
          <button
            key={row.contact_id}
            onClick={() => onSelect(row)}
            className={cn(
              "w-full text-left px-4 py-3 hover:bg-secondary/40 transition-colors flex gap-3",
              active && "bg-secondary/60",
            )}
          >
            <div className="relative shrink-0">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary">
                {(row.contact_name ?? "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              {row.unread && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-primary ring-2 ring-card" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className={cn("text-sm truncate", row.unread ? "font-semibold text-foreground" : "font-medium text-foreground")}>
                  {row.contact_name || "Unknown"}
                </p>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {row.last_activity_at ? relativeTime(row.last_activity_at) : ""}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <Icon className="w-3 h-3 text-muted-foreground shrink-0" />
                <p className="text-xs text-muted-foreground truncate">{row.snippet || "—"}</p>
              </div>
            </div>
            {row.needs_reply && (
              <span className="self-center text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 uppercase tracking-wide shrink-0">
                Reply
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Thread items ───────────────────────────────────────────────────────────

function CallRow({ item, orgId, contact }: { item: ConversationThreadItem; orgId: string; contact: { id: string; name: string; phone: string | null } }) {
  const [open, setOpen] = useState(false);
  const meta = item.metadata as { summary?: string; transcript?: string; durationMs?: number; isUrgent?: boolean; inVoicemail?: boolean };
  return (
    <div className="mx-auto max-w-[85%] w-full rounded-xl border border-[hsl(var(--accent-violet))]/20 bg-[hsl(var(--accent-violet))]/5 p-3">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
        <Phone className="w-4 h-4 text-[hsl(var(--accent-violet))] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground">
            {item.direction === "outbound" ? "Outbound call" : "Inbound call"}
            {item.status ? ` · ${item.status}` : ""}
            {meta.isUrgent ? " · 🚨 urgent" : ""}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">{meta.summary || item.title || "Call"}</p>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(item.occurred_at)}</span>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {meta.summary && <p className="text-xs text-foreground/80">{meta.summary}</p>}
          {meta.transcript ? (
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap max-h-64 overflow-y-auto rounded-lg bg-card border border-border p-2.5">
              {meta.transcript}
            </pre>
          ) : (
            <p className="text-[11px] text-muted-foreground/70">No transcript captured.</p>
          )}
          <VoicePanel orgId={orgId} contact={contact} />
        </div>
      )}
    </div>
  );
}

function ThreadItem({ item, orgId, contact }: { item: ConversationThreadItem; orgId: string; contact: { id: string; name: string; phone: string | null } }) {
  if (item.kind === "call") return <CallRow item={item} orgId={orgId} contact={contact} />;

  if (item.kind === "message") {
    const outbound = item.direction === "outbound";
    const Icon = channelIcon(item.channel);
    return (
      <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
        <div className={cn("max-w-[75%] rounded-2xl px-3.5 py-2", outbound ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>
          {(item.metadata as { subject?: string }).subject && (
            <p className="text-xs font-semibold mb-1">{(item.metadata as { subject?: string }).subject}</p>
          )}
          <p className="text-sm whitespace-pre-wrap break-words">{item.body}</p>
          <div className={cn("flex items-center gap-1 mt-1", outbound ? "text-primary-foreground/70 justify-end" : "text-muted-foreground")}>
            {(item.metadata as { sentBy?: string } | null)?.sentBy === "sms_agent" && (
              <span className="flex items-center gap-0.5 text-[10px] font-semibold mr-1">
                <Bot className="w-2.5 h-2.5" /> Assistant
              </span>
            )}
            <Icon className="w-2.5 h-2.5" />
            <span className="text-[10px]">
              {relativeTime(item.occurred_at)}
              {item.status && item.status !== "sent" && item.status !== "received" ? ` · ${item.status}` : ""}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "draft") {
    return (
      <div className="mx-auto max-w-[85%] w-full rounded-xl border border-dashed border-border bg-card p-3 flex items-start gap-2">
        <Sparkles className="w-4 h-4 text-[hsl(var(--accent-violet))] shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">AI draft{item.status ? ` · ${item.status}` : ""}</p>
          <p className="text-[11px] text-muted-foreground truncate">{item.body}</p>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(item.occurred_at)}</span>
      </div>
    );
  }

  // event / lead — a system line.
  const label = item.kind === "lead" ? `Web form: ${item.title ?? "lead"}` : prettyEvent(item.title ?? "event");
  return (
    <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
      <Activity className="w-3 h-3" />
      <span className="capitalize">{label}</span>
      <span className="text-muted-foreground/60">· {relativeTime(item.occurred_at)}</span>
    </div>
  );
}

// ─── Composer ─────────────────────────────────────────────────────────────────

function Composer({ orgId, contact }: { orgId: string; contact: InboxRow }) {
  const send = useSendContactMessage(orgId, contact.contact_id as string);
  const qc = useQueryClient();
  const [channel, setChannel] = useState<"sms" | "email">(contact.contact_phone ? "sms" : "email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const destination = channel === "sms" ? contact.contact_phone : contact.contact_email;

  const handleSend = async () => {
    if (!body.trim()) return;
    try {
      const result = await send.mutateAsync({ channel, body: body.trim(), subject: subject.trim() || undefined });
      if (result.status === "sent") {
        toast.success(channel === "sms" ? "SMS sent" : "Email sent");
        // A manual text = you've taken over from the assistant (server marks it).
        if (channel === "sms") void qc.invalidateQueries({ queryKey: ["front-desk", "assistant", orgId, contact.contact_id] });
        setBody("");
        setSubject("");
      } else if (result.status === "blocked") {
        toast.error(`Not sent — ${result.reason ?? "blocked"}${result.reason === "opted_out" ? " (contact opted out)" : ""}`);
      } else {
        toast.error(`Send failed${result.reason ? ` — ${result.reason}` : ""}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Send failed.");
    }
  };

  return (
    <div className="border-t border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setChannel("sms")}
          disabled={!contact.contact_phone}
          className={cn("flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-40",
            channel === "sms" ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground hover:text-foreground")}
        >
          <MessageSquare className="w-3 h-3" /> SMS
        </button>
        <button
          onClick={() => setChannel("email")}
          disabled={!contact.contact_email}
          className={cn("flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-40",
            channel === "email" ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground hover:text-foreground")}
        >
          <Mail className="w-3 h-3" /> Email
        </button>
        <span className="text-[11px] text-muted-foreground ml-auto truncate">
          {destination ? `To ${destination}` : `No ${channel === "sms" ? "phone" : "email"} on file`}
        </span>
      </div>
      {channel === "email" && (
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          className="w-full rounded-lg bg-secondary border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder={channel === "sms" ? "Type an SMS reply…" : "Type an email…"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSend(); }
          }}
          className="flex-1 rounded-lg bg-secondary border border-border px-3 py-2 text-sm text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          onClick={() => void handleSend()}
          disabled={!body.trim() || !destination || send.isPending}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 active:scale-[0.97]"
        >
          {send.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground/70">
        Consent is checked before anything goes out. ⌘/Ctrl + Enter to send.
      </p>
    </div>
  );
}

// ─── Conversation pane ────────────────────────────────────────────────────────

function ConversationPane({ orgId, row }: { orgId: string; row: InboxRow }) {
  const contactId = row.contact_id as string;
  const { data: thread, isLoading, isError, refetch } = useConversationThread(orgId, contactId);
  const contact = { id: contactId, name: row.contact_name ?? "Unknown", phone: row.contact_phone };

  // Newest-first from the RPC; render oldest→newest so the latest sits at the bottom.
  const ordered = useMemo(() => (thread ? toChronological(thread) : []), [thread]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{row.contact_name || "Unknown"}</p>
          <p className="text-[11px] text-muted-foreground truncate">
            {[row.contact_phone, row.contact_email, row.company_name].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AssistantControl orgId={orgId} contactId={contactId} />
          <VoicePanel orgId={orgId} contact={contact} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-8">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading conversation…
          </div>
        ) : isError ? (
          <ErrorBanner message="Couldn't load this conversation." onRetry={() => refetch()} />
        ) : ordered.length === 0 ? (
          <EmptyState title="No messages yet" description="Send the first message below." />
        ) : (
          ordered.map((item) => <ThreadItem key={`${item.kind}-${item.id}`} item={item} orgId={orgId} contact={contact} />)
        )}
      </div>

      <Composer orgId={orgId} contact={row} />
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { organizationId, companyId } = useOrg();
  const [search, setSearch] = useState("");
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const params = useMemo(
    () => ({ companyId: companyId || undefined, search: search || undefined, needsReply: needsReplyOnly }),
    [companyId, search, needsReplyOnly],
  );
  const { data: rows, isLoading, isError, refetch } = useInbox(organizationId, params);
  const markRead = useMarkContactRead(organizationId);

  const selectedRow = (rows ?? []).find((r) => r.contact_id === selectedId) ?? null;

  const handleSelect = (row: InboxRow) => {
    setSelectedId(row.contact_id);
    if (row.contact_id) markRead.mutate(row.contact_id);
  };

  return (
    <div className="max-w-[1200px] mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <Inbox className="w-5 h-5 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Inbox</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(280px,360px)_1fr] gap-4 h-[calc(100vh-180px)]">
        {/* Left: list */}
        <div className="bg-card border border-border rounded-xl flex flex-col overflow-hidden">
          <div className="p-3 border-b border-border space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations…"
                className="w-full bg-secondary/40 border border-border rounded-lg pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={needsReplyOnly} onChange={(e) => setNeedsReplyOnly(e.target.checked)} />
              Needs reply only
            </label>
          </div>
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-8">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : isError ? (
              <div className="p-3"><ErrorBanner message="Couldn't load the inbox." onRetry={() => refetch()} /></div>
            ) : (
              <InboxList rows={rows ?? []} selectedId={selectedId} onSelect={handleSelect} />
            )}
          </div>
        </div>

        {/* Right: conversation */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {selectedRow ? (
            <ConversationPane orgId={organizationId} row={selectedRow} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <EmptyState title="Select a conversation" description="Pick a contact on the left to see and answer everything." />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
