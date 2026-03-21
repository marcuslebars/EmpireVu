import { cn } from "@/lib/utils";
import React from "react";

interface DashboardCardProps {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
  style?: React.CSSProperties;
}

export function DashboardCard({ title, icon, children, className, action, style }: DashboardCardProps) {
  return (
    <div
      className={cn(
        "bg-card border border-border rounded-xl p-5 transition-shadow duration-200 hover:shadow-lg hover:shadow-black/10",
        className
      )}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  change,
  positive,
}: {
  label: string;
  value: string;
  change?: string;
  positive?: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5 transition-shadow duration-200 hover:shadow-lg hover:shadow-black/10">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{label}</p>
      <p className="text-2xl font-bold text-foreground tracking-tight">{value}</p>
      {change && (
        <p
          className={cn(
            "text-xs font-medium mt-1",
            positive ? "text-success" : "text-destructive"
          )}
        >
          {positive ? "↑" : "↓"} {change}
        </p>
      )}
    </div>
  );
}
