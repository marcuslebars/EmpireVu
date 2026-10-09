import { Bot, Loader2, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { useAssistantStatus, useSetAssistantHandling } from "@/lib/front-desk-api";

function until(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return ` until ${d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })} ${d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Inbox thread header: who's answering this customer's texts — the assistant or you — with a
 * "Take over" / "Let AI handle it" switch. Hidden when the AI front desk is off for the company.
 */
export function AssistantControl({ orgId, contactId }: { orgId: string; contactId: string }) {
  const { data } = useAssistantStatus(orgId, contactId);
  const set = useSetAssistantHandling(orgId, contactId);
  if (!data || !data.agentActive) return null;

  const aiHandling = data.state === "ai" || data.state === "closed";
  const label = aiHandling ? "Assistant is handling texts" : data.state === "paused" ? "Assistant paused for this customer" : `You're handling this${until(data.takeoverEndsAt)}`;

  const toggle = () =>
    set.mutate(!aiHandling, {
      onSuccess: (next) => toast.success(next.state === "ai" ? "The assistant will answer this customer again." : "You've taken over — the assistant will stay quiet."),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't change that"),
    });

  return (
    <div className="flex items-center gap-2 shrink-0" title={data.summary ?? undefined}>
      <span
        className={cn(
          "hidden sm:flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full",
          aiHandling ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground",
        )}
      >
        {aiHandling ? <Bot className="w-3 h-3" /> : <UserRound className="w-3 h-3" />}
        {label}
      </span>
      <button
        onClick={toggle}
        disabled={set.isPending}
        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
      >
        {set.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : aiHandling ? <UserRound className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
        {aiHandling ? "Take over" : "Let AI handle it"}
      </button>
    </div>
  );
}
