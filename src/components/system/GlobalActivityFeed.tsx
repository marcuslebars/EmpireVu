/**
 * GlobalActivityFeed — renders a live system trace / activity timeline.
 *
 * Accepts either:
 *  - `items` (DashboardActivityItem[]) for the dashboard feed
 *  - `trace` (TraceRecord[]) for entity-level trace panels
 *
 * The legacy `SystemEvent` type and static `globalEvents` mock data have been
 * removed. All consumers should pass live data from React Query hooks.
 */

import {
  Calendar, CheckCircle2, Zap, UserPlus, DollarSign, Bell, ClipboardList,
  ChevronRight, Target, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import type { DashboardActivityItem, TraceRecord } from "@/lib/api-client";

// ─── Event type → icon / colour map ──────────────────────────────────────────

const eventConfig: Record<string, { icon: typeof Calendar; color: string; bg: string }> = {
  booking_created:    { icon: Calendar,      color: "text-primary",                              bg: "bg-primary/10" },
  booking_completed:  { icon: CheckCircle2,  color: "text-[hsl(var(--success))]",                bg: "bg-[hsl(var(--success))]/10" },
  workflow_triggered: { icon: Zap,           color: "text-[hsl(var(--accent-violet))]",          bg: "bg-[hsl(var(--accent-violet))]/10" },
  workflow_run:       { icon: Zap,           color: "text-[hsl(var(--accent-violet))]",          bg: "bg-[hsl(var(--accent-violet))]/10" },
  task_created:       { icon: ClipboardList, color: "text-[hsl(var(--warning))]",                bg: "bg-[hsl(var(--warning))]/10" },
  task_completed:     { icon: CheckCircle2,  color: "text-[hsl(var(--success))]",                bg: "bg-[hsl(var(--success))]/10" },
  contact_created:    { icon: UserPlus,      color: "text-primary",                              bg: "bg-primary/10" },
  contact_updated:    { icon: UserPlus,      color: "text-primary",                              bg: "bg-primary/10" },
  payment_received:   { icon: DollarSign,    color: "text-[hsl(var(--success))]",                bg: "bg-[hsl(var(--success))]/10" },
  stage_changed:      { icon: Target,        color: "text-[hsl(var(--accent-violet))]",          bg: "bg-[hsl(var(--accent-violet))]/10" },
  notification_sent:  { icon: Bell,          color: "text-muted-foreground",                     bg: "bg-secondary" },
  activity_event:     { icon: Activity,      color: "text-primary",                              bg: "bg-primary/10" },
  booking:            { icon: Calendar,      color: "text-primary",                              bg: "bg-primary/10" },
  comment:            { icon: Bell,          color: "text-muted-foreground",                     bg: "bg-secondary" },
  task:               { icon: ClipboardList, color: "text-[hsl(var(--warning))]",                bg: "bg-[hsl(var(--warning))]/10" },
};

const fallbackConfig = { icon: Activity, color: "text-muted-foreground", bg: "bg-secondary" };

// ─── Dashboard Activity Feed ──────────────────────────────────────────────────

interface DashboardFeedProps {
  items: DashboardActivityItem[];
  maxItems?: number;
  compact?: boolean;
}

export function DashboardActivityFeed({ items, maxItems = 8, compact = false }: DashboardFeedProps) {
  const displayed = items.slice(0, maxItems);

  return (
    <div className="space-y-0.5">
      {displayed.map((item) => {
        const cfg = eventConfig[item.eventType] ?? fallbackConfig;
        const Icon = cfg.icon;
        const companyName = item.company?.name ?? "";

        return (
          <div key={item.id} className={cn(
            "flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer",
            compact && "px-2 py-2"
          )}>
            <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5", cfg.bg)}>
              <Icon className={cn("w-3.5 h-3.5", cfg.color)} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground leading-snug">
                <span className="font-medium">{item.eventType.replace(/_/g, " ")}</span>
                {item.entity && (
                  <span className="text-foreground/70"> · {item.entity.label}</span>
                )}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                {companyName && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-muted-foreground" />
                    {companyName}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground/50">·</span>
                <span className="text-[10px] text-muted-foreground/50">{relativeTime(item.occurredAt)}</span>
                {item.relatedEntity && (
                  <>
                    <span className="text-[10px] text-muted-foreground/50">·</span>
                    <span className="text-[10px] text-primary font-medium">{item.relatedEntity.label}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Entity System Trace Chain ────────────────────────────────────────────────

interface TraceChainProps {
  trace: TraceRecord[];
  maxItems?: number;
  compact?: boolean;
}

export function SystemTraceChain({ trace, maxItems, compact = false }: TraceChainProps) {
  const displayed = maxItems ? trace.slice(0, maxItems) : trace;

  return (
    <div className="space-y-0">
      {displayed.map((record, i) => {
        const cfg = eventConfig[record.kind] ?? fallbackConfig;
        const Icon = cfg.icon;
        return (
          <div key={record.id} className="flex items-start gap-2.5 relative">
            {i < displayed.length - 1 && (
              <div className="absolute left-[11px] top-7 w-px h-[calc(100%-8px)] bg-border" />
            )}
            <div className={cn("w-[22px] h-[22px] rounded-md flex items-center justify-center shrink-0 z-10", cfg.bg)}>
              <Icon className={cn("w-2.5 h-2.5", cfg.color)} />
            </div>
            <div className="pb-3 min-w-0">
              <p className="text-[11px] font-medium text-foreground leading-snug">{record.title}</p>
              <p className="text-[10px] text-muted-foreground truncate">{record.detail}</p>
              <p className="text-[9px] text-muted-foreground/50 mt-0.5">{relativeTime(record.occurredAt)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Inline trace feed (for detail panels with expandable steps) ──────────────

interface InlineTraceFeedProps {
  trace: TraceRecord[];
  maxItems?: number;
  compact?: boolean;
  showTrace?: boolean;
}

export default function GlobalActivityFeed({ trace, maxItems = 6, compact = false }: InlineTraceFeedProps) {
  const displayed = trace.slice(0, maxItems);

  return (
    <div className="space-y-0.5">
      {displayed.map((record, i) => {
        const cfg = eventConfig[record.kind] ?? fallbackConfig;
        const Icon = cfg.icon;

        return (
          <div key={record.id} className="group">
            <div className={cn(
              "flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer",
              compact && "px-2 py-2"
            )}>
              <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5", cfg.bg)}>
                <Icon className={cn("w-3.5 h-3.5", cfg.color)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground leading-snug">
                  <span className="font-medium">{record.title}</span>
                  {!compact && <span className="text-foreground/70"> · {record.detail}</span>}
                  {compact && <span className="text-muted-foreground text-xs block mt-0.5 truncate">{record.detail}</span>}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  {record.company && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-muted-foreground" />
                      {record.company.name}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground/50">·</span>
                  <span className="text-[10px] text-muted-foreground/50">{relativeTime(record.occurredAt)}</span>
                  {record.entity && (
                    <>
                      <span className="text-[10px] text-muted-foreground/50">·</span>
                      <span className="text-[10px] text-primary font-medium">{record.entity.label}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
