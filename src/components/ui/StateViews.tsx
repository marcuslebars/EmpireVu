/**
 * Reusable loading, empty, and error state components.
 * Designed to be subtle and consistent with the Hubcos design system.
 */

import { AlertTriangle, RefreshCw, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Skeleton ────────────────────────────────────────────────────────────────

export function SkeletonLine({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-3.5 rounded-md bg-secondary/80 animate-pulse",
        className,
      )}
    />
  );
}

export function SkeletonCard({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5 p-4 rounded-xl border border-border bg-card", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine
          key={i}
          className={i === 0 ? "w-2/3" : i === rows - 1 ? "w-1/2" : "w-full"}
        />
      ))}
    </div>
  );
}

export function SkeletonRow({ cols = 4, className }: { cols?: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 px-4 py-3", className)}>
      {Array.from({ length: cols }).map((_, i) => (
        <SkeletonLine
          key={i}
          className={cn("flex-1 h-3", i === 0 && "max-w-[120px]")}
        />
      ))}
    </div>
  );
}

export function SkeletonStatCard() {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-2">
      <SkeletonLine className="w-1/2 h-3" />
      <SkeletonLine className="w-1/3 h-6" />
      <SkeletonLine className="w-2/3 h-2.5" />
    </div>
  );
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export function LoadingRows({ count = 5 }: { count?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

export function LoadingCards({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

// ─── Empty ───────────────────────────────────────────────────────────────────

export function EmptyState({
  icon: Icon = Inbox,
  title = "No results",
  description,
  action,
  className,
}: {
  icon?: React.ElementType;
  title?: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-12 text-center", className)}>
      <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center mb-3">
        <Icon className="w-5 h-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

// ─── Error ───────────────────────────────────────────────────────────────────

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-10 text-center", className)}>
      <div className="w-10 h-10 rounded-xl bg-destructive/10 flex items-center justify-center mb-3">
        <AlertTriangle className="w-5 h-5 text-destructive" />
      </div>
      <p className="text-sm font-medium text-foreground">Something went wrong</p>
      {message && (
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">{message}</p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

// ─── Inline error banner ─────────────────────────────────────────────────────

export function ErrorBanner({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 bg-destructive/8 border border-destructive/20 rounded-xl px-4 py-3">
      <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
      <p className="text-sm text-foreground flex-1">
        {message ?? "Failed to load data."}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1 text-xs font-medium text-destructive hover:text-destructive/80 transition-colors shrink-0"
        >
          <RefreshCw className="w-3 h-3" />
          Retry
        </button>
      )}
    </div>
  );
}
