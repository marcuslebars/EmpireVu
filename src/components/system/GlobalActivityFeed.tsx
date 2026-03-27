import { Activity, AlertTriangle, Calendar, CheckCircle2, Clock, Workflow } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SystemEvent {
  company?: string | null;
  detail: string;
  id: string;
  timestamp: string;
  title: string;
  type: "activity" | "alert" | "booking" | "task" | "workflow";
}

const config = {
  activity: { bg: "bg-primary/10", icon: Activity, text: "text-primary" },
  alert: { bg: "bg-destructive/10", icon: AlertTriangle, text: "text-destructive" },
  booking: { bg: "bg-secondary", icon: Calendar, text: "text-primary" },
  task: { bg: "bg-emerald-500/10", icon: CheckCircle2, text: "text-emerald-400" },
  workflow: { bg: "bg-amber-500/10", icon: Workflow, text: "text-amber-400" },
} satisfies Record<SystemEvent["type"], { bg: string; icon: typeof Activity; text: string }>;

interface Props {
  compact?: boolean;
  events?: SystemEvent[];
  maxItems?: number;
}

export default function GlobalActivityFeed({ compact = false, events = [], maxItems = 6 }: Props) {
  const visibleEvents = events.slice(0, maxItems);

  return (
    <div className="space-y-2">
      {visibleEvents.map((event) => {
        const entry = config[event.type];
        const Icon = entry.icon;

        return (
          <div key={event.id} className={cn("flex items-start gap-3 rounded-lg border border-border/60 bg-background/30 px-3 py-3", compact && "py-2") }>
            <div className={cn("rounded-lg p-2", entry.bg)}>
              <Icon className={cn("h-4 w-4", entry.text)} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{event.title}</p>
              <p className="text-sm text-muted-foreground">{event.detail}</p>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>{event.timestamp}</span>
                {event.company ? <span>· {event.company}</span> : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SystemTraceChain({ events }: { events: SystemEvent[] }) {
  return (
    <div className="space-y-2">
      {events.map((event) => (
        <div key={event.id} className="rounded-lg border border-border/60 bg-background/30 px-3 py-3">
          <p className="text-sm font-medium text-foreground">{event.title}</p>
          <p className="text-xs text-muted-foreground">{event.detail}</p>
          <p className="mt-1 text-xs text-muted-foreground">{event.timestamp}</p>
        </div>
      ))}
    </div>
  );
}