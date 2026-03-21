import { cn } from "@/lib/utils";
import React from "react";

interface DashboardCardProps {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
  style?: React.CSSProperties;
  variant?: "default" | "urgent" | "elevated";
  badge?: string | number;
}

export function DashboardCard({
  title,
  icon,
  children,
  className,
  action,
  style,
  variant = "default",
  badge,
}: DashboardCardProps) {
  return (
    <div
      style={style}
      className={cn(
        "rounded-xl p-5 transition-all duration-200",
        variant === "urgent"
          ? "bg-card border border-destructive/20 shadow-[0_0_24px_-4px_hsl(0_72%_51%/0.08)]"
          : variant === "elevated"
            ? "bg-[hsl(var(--card-elevated))] border border-border shadow-lg shadow-black/20"
            : "bg-card border border-border shadow-md shadow-black/10",
        "hover:shadow-lg hover:shadow-black/15",
        className
      )}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          {icon && (
            <span
              className={cn(
                "flex items-center justify-center w-7 h-7 rounded-md",
                variant === "urgent"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-secondary text-muted-foreground"
              )}
            >
              {icon}
            </span>
          )}
          <h3 className="text-sm font-semibold text-foreground tracking-tight">{title}</h3>
          {badge !== undefined && (
            <span
              className={cn(
                "text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none",
                variant === "urgent"
                  ? "bg-destructive/15 text-destructive"
                  : "bg-primary/15 text-primary"
              )}
            >
              {badge}
            </span>
          )}
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
  icon,
}: {
  label: string;
  value: string;
  change?: string;
  positive?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5 transition-all duration-200 hover:shadow-lg hover:shadow-black/15 shadow-md shadow-black/10">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </p>
        {icon && (
          <span className="flex items-center justify-center w-7 h-7 rounded-md bg-secondary text-muted-foreground">
            {icon}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold text-foreground tracking-tight">{value}</p>
      {change && (
        <p
          className={cn(
            "text-xs font-medium mt-1.5",
            positive ? "text-success" : "text-destructive"
          )}
        >
          {positive ? "↑" : "↓"} {change}
        </p>
      )}
    </div>
  );
}
