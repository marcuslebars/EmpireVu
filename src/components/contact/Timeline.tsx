import { Activity, Phone } from "lucide-react";

import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import { EmptyState } from "@/components/ui/StateViews";
import type { ContactDetailResponse } from "@/lib/api-client";

/**
 * The contact's activity timeline (Task 12 decomposition). Renders the normalized trace;
 * the org-wide inbox uses the richer unified conversation thread, and this switches to it
 * in a follow-up so both surfaces read from `ui_conversation_thread`.
 */
export function Timeline({ timeline }: { timeline: ContactDetailResponse["timeline"] }) {
  if (timeline.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-5">
        <EmptyState title="No activity yet" description="Events will appear here as they occur." />
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="space-y-0">
        {timeline.map((item, i) => (
          <div key={item.id} className="flex gap-3 relative">
            {i < timeline.length - 1 && <div className="absolute left-[15px] top-9 bottom-0 w-px bg-border/50" />}
            <div
              className={cn(
                "w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center shrink-0 z-10",
                item.metadata?.channel === "voice" ? "text-[hsl(var(--accent-violet))]" : "text-primary",
              )}
            >
              {item.metadata?.channel === "voice" ? <Phone className="w-3.5 h-3.5" /> : <Activity className="w-3.5 h-3.5" />}
            </div>
            <div className="pb-5 flex-1">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                <p className="text-[10px] text-muted-foreground/60">{relativeTime(item.occurredAt)}</p>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
