import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export function LoadingState({ label = "Loading Syncoree data..." }: { label?: string }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card/60 px-6 py-10 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

export function ErrorState({
  description,
  onRetry,
  title = "Something went wrong",
}: {
  description: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-6 py-10 text-center">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="max-w-lg text-sm text-muted-foreground">{description}</p>
      </div>
      {onRetry ? (
        <Button onClick={onRetry} size="sm" variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-lg text-sm text-muted-foreground">{description}</p>
    </div>
  );
}