import { Activity, FileText, Loader2, Mail, MessageSquare, Phone, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import { EmptyState, ErrorBanner } from "@/components/ui/StateViews";
import { useConversationThread } from "@/lib/api-hooks";
import type { ConversationThreadItem } from "@/lib/api-client";

/**
 * The contact's activity timeline (Task 12). Reads the unified conversation thread
 * (ui_conversation_thread) so it shows messages, calls, form leads, AI drafts, and
 * contact/quote events in one stream — the same source the org-wide inbox uses.
 */

function describe(item: ConversationThreadItem): { icon: typeof Activity; accent: boolean; title: string; detail: string } {
  const meta = item.metadata as Record<string, unknown>;
  switch (item.kind) {
    case "message":
      return {
        icon: item.channel === "email" ? Mail : MessageSquare,
        accent: false,
        title: `${item.direction === "outbound" ? "Sent" : "Received"} ${item.channel ?? "message"}`,
        detail: item.body ?? "",
      };
    case "call":
      return {
        icon: Phone,
        accent: true,
        title: `${item.direction === "outbound" ? "Outbound" : "Inbound"} call${item.status ? ` · ${item.status}` : ""}`,
        detail: (meta.summary as string) ?? item.title ?? "Call",
      };
    case "draft":
      return { icon: Sparkles, accent: true, title: `AI draft${item.status ? ` · ${item.status}` : ""}`, detail: item.body ?? "" };
    case "lead":
      return { icon: FileText, accent: false, title: `Web form: ${item.title ?? "lead"}`, detail: (meta.source as string) ?? "" };
    default:
      return { icon: Activity, accent: false, title: (item.title ?? "event").replace(/^contact\.|^quote\./, "").replace(/[._]/g, " "), detail: item.body ?? "" };
  }
}

export function Timeline({ orgId, contactId }: { orgId: string; contactId: string }) {
  const { data: thread, isLoading, isError, refetch } = useConversationThread(orgId, contactId);

  if (isLoading) {
    return (
      <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading activity…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <ErrorBanner message="Couldn't load activity." onRetry={() => refetch()} />
      </div>
    );
  }
  if (!thread || thread.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <EmptyState title="No activity yet" description="Messages, calls, and events will appear here." />
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="space-y-0">
        {thread.map((item, i) => {
          const d = describe(item);
          return (
            <div key={`${item.kind}-${item.id}`} className="flex gap-3 relative">
              {i < thread.length - 1 && <div className="absolute left-[15px] top-9 bottom-0 w-px bg-border/50" />}
              <div
                className={cn(
                  "w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center shrink-0 z-10",
                  d.accent ? "text-[hsl(var(--accent-violet))]" : "text-primary",
                )}
              >
                <d.icon className="w-3.5 h-3.5" />
              </div>
              <div className="pb-5 flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground capitalize">{d.title}</p>
                  <p className="text-[10px] text-muted-foreground/60 shrink-0">{relativeTime(item.occurred_at)}</p>
                </div>
                {d.detail && <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap break-words line-clamp-4">{d.detail}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
