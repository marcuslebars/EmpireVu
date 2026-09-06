import { AlertTriangle, ArrowRight, Clock, Star, Zap } from "lucide-react";

// Shared styling maps for the contact-detail components (Task 12 decomposition).

export const stageConfig: Record<string, { bg: string; text: string }> = {
  lead: { bg: "bg-muted", text: "text-muted-foreground" },
  qualified: { bg: "bg-primary/15", text: "text-primary" },
  active: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  closed: { bg: "bg-violet-500/15", text: "text-violet-400" },
};

export const stageLabel: Record<string, string> = {
  lead: "Lead",
  qualified: "Qualified",
  active: "Active",
  closed: "Closed",
};

export const pipelineStageOrder = ["lead", "qualified", "active", "closed"] as const;

export const actionTypeConfig: Record<string, { bg: string; text: string; border: string; icon: typeof Zap }> = {
  urgent: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20", icon: AlertTriangle },
  action: { bg: "bg-primary/10", text: "text-primary", border: "border-primary/20", icon: ArrowRight },
  wait: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20", icon: Clock },
  done: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20", icon: Star },
};

export const priorityConfig: Record<string, { bg: string; text: string }> = {
  urgent: { bg: "bg-red-500/15", text: "text-red-400" },
  high: { bg: "bg-red-500/15", text: "text-red-400" },
  medium: { bg: "bg-amber-500/15", text: "text-amber-400" },
  low: { bg: "bg-muted", text: "text-muted-foreground" },
};

export const taskStatusConfig: Record<string, { bg: string; text: string }> = {
  todo: { bg: "bg-muted", text: "text-muted-foreground" },
  in_progress: { bg: "bg-primary/15", text: "text-primary" },
  completed: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  blocked: { bg: "bg-red-500/15", text: "text-red-400" },
};

export const bookingStatusConfig: Record<string, { bg: string; text: string }> = {
  confirmed: { bg: "bg-primary/15", text: "text-primary" },
  pending: { bg: "bg-amber-500/15", text: "text-amber-400" },
  completed: { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  cancelled: { bg: "bg-muted", text: "text-muted-foreground" },
  no_show: { bg: "bg-red-500/15", text: "text-red-400" },
  conflict: { bg: "bg-red-500/15", text: "text-red-400" },
};

export const aiUrgencyStyle: Record<string, string> = {
  high: "bg-[hsl(var(--urgent))]/15 text-[hsl(var(--urgent))]",
  medium: "bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]",
  low: "bg-muted text-muted-foreground",
};
