import {
  Calendar, CheckCircle2, Zap, UserPlus, DollarSign, Bell, ClipboardList,
  ArrowRight, ChevronRight, Target, Send,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface SystemEvent {
  id: string;
  type: "booking_created" | "workflow_triggered" | "task_created" | "task_completed" | "contact_updated" | "payment_received" | "stage_changed" | "notification_sent";
  title: string;
  detail: string;
  company: string;
  timestamp: string;
  entity?: { type: "contact" | "booking" | "task" | "workflow"; name: string; id?: string };
  trace?: SystemEvent[];
}

const eventConfig: Record<string, { icon: typeof Calendar; color: string; bg: string }> = {
  booking_created: { icon: Calendar, color: "text-primary", bg: "bg-primary/10" },
  workflow_triggered: { icon: Zap, color: "text-[hsl(var(--accent-violet))]", bg: "bg-[hsl(var(--accent-violet))]/10" },
  task_created: { icon: ClipboardList, color: "text-[hsl(var(--warning))]", bg: "bg-[hsl(var(--warning))]/10" },
  task_completed: { icon: CheckCircle2, color: "text-[hsl(var(--success))]", bg: "bg-[hsl(var(--success))]/10" },
  contact_updated: { icon: UserPlus, color: "text-primary", bg: "bg-primary/10" },
  payment_received: { icon: DollarSign, color: "text-[hsl(var(--success))]", bg: "bg-[hsl(var(--success))]/10" },
  stage_changed: { icon: Target, color: "text-[hsl(var(--accent-violet))]", bg: "bg-[hsl(var(--accent-violet))]/10" },
  notification_sent: { icon: Bell, color: "text-muted-foreground", bg: "bg-secondary" },
};

const companyDotColors: Record<string, string> = {
  "A1 Marine Care": "bg-[hsl(195_80%_50%)]",
  "RankLocal": "bg-[hsl(152_60%_48%)]",
  "MarineMecca": "bg-[hsl(38_92%_55%)]",
  "Vitatee": "bg-[hsl(280_70%_58%)]",
  "Thinker Holdings": "bg-primary",
};

// Shared sample data for global activity
export const globalEvents: SystemEvent[] = [
  {
    id: "evt-1", type: "booking_created", title: "Booking created", detail: "Vessel Hull Inspection — Port Authority NZ",
    company: "A1 Marine Care", timestamp: "12 min ago",
    entity: { type: "booking", name: "Vessel Hull Inspection", id: "1" },
    trace: [
      { id: "t1a", type: "workflow_triggered", title: "Workflow triggered", detail: "New Booking Workflow", company: "A1 Marine Care", timestamp: "12 min ago" },
      { id: "t1b", type: "task_created", title: "Task created", detail: "Confirm vessel inspection details", company: "A1 Marine Care", timestamp: "12 min ago", entity: { type: "task", name: "TSK-001" } },
      { id: "t1c", type: "notification_sent", title: "Notification sent", detail: "Marcus Reeves assigned", company: "A1 Marine Care", timestamp: "11 min ago" },
    ],
  },
  {
    id: "evt-2", type: "contact_updated", title: "Contact updated", detail: "BioNova Health — stage changed to Qualified",
    company: "Vitatee", timestamp: "34 min ago",
    entity: { type: "contact", name: "BioNova Health", id: "4" },
    trace: [
      { id: "t2a", type: "stage_changed", title: "CRM stage changed", detail: "Lead → Qualified", company: "Vitatee", timestamp: "34 min ago" },
      { id: "t2b", type: "workflow_triggered", title: "Workflow triggered", detail: "Pipeline Stage Automation", company: "Vitatee", timestamp: "34 min ago" },
      { id: "t2c", type: "task_created", title: "Task created", detail: "Schedule follow-up call", company: "Vitatee", timestamp: "33 min ago" },
    ],
  },
  {
    id: "evt-3", type: "task_completed", title: "Task completed", detail: "Safety equipment checklist — Horizon Maritime Ltd",
    company: "A1 Marine Care", timestamp: "1h ago",
    entity: { type: "task", name: "TSK-009" },
  },
  {
    id: "evt-4", type: "payment_received", title: "Payment received", detail: "$4,200 — Invoice #INV-0847",
    company: "RankLocal", timestamp: "2h ago",
    entity: { type: "contact", name: "Pacific Digital Agency", id: "2" },
  },
  {
    id: "evt-5", type: "workflow_triggered", title: "Workflow triggered", detail: "Lead Follow-Up → Created task for GreenWave Marketing",
    company: "RankLocal", timestamp: "3h ago",
    entity: { type: "workflow", name: "Lead Follow-Up" },
    trace: [
      { id: "t5a", type: "task_created", title: "Task created", detail: "Send proposal to GreenWave Marketing", company: "RankLocal", timestamp: "3h ago" },
      { id: "t5b", type: "notification_sent", title: "Notification sent", detail: "Kira Lam notified", company: "RankLocal", timestamp: "3h ago" },
    ],
  },
  {
    id: "evt-6", type: "booking_created", title: "Booking created", detail: "Product Photoshoot — MarineMecca",
    company: "MarineMecca", timestamp: "4h ago",
    entity: { type: "booking", name: "Product Photoshoot", id: "5" },
  },
];

interface Props {
  events?: SystemEvent[];
  maxItems?: number;
  compact?: boolean;
  showTrace?: boolean;
}

export default function GlobalActivityFeed({ events = globalEvents, maxItems = 6, compact = false, showTrace = true }: Props) {
  const displayed = events.slice(0, maxItems);

  return (
    <div className="space-y-0.5">
      {displayed.map((evt) => {
        const cfg = eventConfig[evt.type];
        const Icon = cfg.icon;
        const hasTrace = showTrace && evt.trace && evt.trace.length > 0;

        return (
          <div key={evt.id} className="group">
            {/* Main event */}
            <div className={cn(
              "flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 transition-colors cursor-pointer",
              compact && "px-2 py-2"
            )}>
              <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5", cfg.bg)}>
                <Icon className={cn("w-3.5 h-3.5", cfg.color)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground leading-snug">
                  <span className="font-medium">{evt.title}</span>
                  {!compact && <span className="text-foreground/70"> · {evt.detail}</span>}
                  {compact && <span className="text-muted-foreground text-xs block mt-0.5 truncate">{evt.detail}</span>}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", companyDotColors[evt.company] || "bg-muted-foreground")} />
                    {evt.company}
                  </span>
                  <span className="text-[10px] text-muted-foreground/50">·</span>
                  <span className="text-[10px] text-muted-foreground/50">{evt.timestamp}</span>
                  {evt.entity && (
                    <>
                      <span className="text-[10px] text-muted-foreground/50">·</span>
                      <span className="text-[10px] text-primary font-medium">{evt.entity.name}</span>
                    </>
                  )}
                </div>
              </div>
              {hasTrace && (
                <span className="text-[9px] font-semibold text-[hsl(var(--accent-violet))] bg-[hsl(var(--accent-violet))]/10 px-1.5 py-0.5 rounded-md shrink-0 mt-1">
                  {evt.trace!.length} steps
                </span>
              )}
            </div>

            {/* System trace chain */}
            {hasTrace && (
              <div className="ml-[2.15rem] pl-3 border-l-2 border-[hsl(var(--accent-violet))]/20 space-y-0 mb-1">
                {evt.trace!.map((step, si) => {
                  const sCfg = eventConfig[step.type];
                  const SIcon = sCfg.icon;
                  return (
                    <div key={step.id} className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-secondary/40 transition-colors cursor-pointer">
                      <div className={cn("w-5 h-5 rounded-md flex items-center justify-center shrink-0", sCfg.bg)}>
                        <SIcon className={cn("w-2.5 h-2.5", sCfg.color)} />
                      </div>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <ChevronRight className="w-2.5 h-2.5 text-muted-foreground/40 shrink-0" />
                        <span className="text-[11px] text-foreground/70 truncate">{step.title}</span>
                        <span className="text-[10px] text-muted-foreground truncate hidden xl:inline">— {step.detail}</span>
                      </div>
                      <span className="text-[9px] text-muted-foreground/40 ml-auto shrink-0">{step.timestamp}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* Compact system trace for detail panels */
export function SystemTraceChain({ events }: { events: SystemEvent[] }) {
  return (
    <div className="space-y-0">
      {events.map((evt, i) => {
        const cfg = eventConfig[evt.type];
        const Icon = cfg.icon;
        return (
          <div key={evt.id} className="flex items-start gap-2.5 relative">
            {i < events.length - 1 && (
              <div className="absolute left-[11px] top-7 w-px h-[calc(100%-8px)] bg-border" />
            )}
            <div className={cn("w-[22px] h-[22px] rounded-md flex items-center justify-center shrink-0 z-10", cfg.bg)}>
              <Icon className={cn("w-2.5 h-2.5", cfg.color)} />
            </div>
            <div className="pb-3 min-w-0">
              <p className="text-[11px] font-medium text-foreground leading-snug">{evt.title}</p>
              <p className="text-[10px] text-muted-foreground truncate">{evt.detail}</p>
              <p className="text-[9px] text-muted-foreground/50 mt-0.5">{evt.timestamp}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
