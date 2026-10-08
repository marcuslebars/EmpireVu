import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Headset, Loader2, MessageSquare, Phone } from "lucide-react";

import { useAuth } from "@/lib/auth-context";
import { formatAge, tierLabel, type ConciergeAccountSummary, type ConciergeStepDot, type SlaLevel } from "@/lib/concierge";
import { prettyPhone } from "@/lib/carrier-forwarding";
import { cn } from "@/lib/utils";
import NotFound from "@/screens/NotFound";

/** Operator-only: everyone else (signed out included) sees the normal not-found page. */
export function OperatorGate({ children }: { children: ReactNode }) {
  const { status, session } = useAuth();
  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (status !== "authenticated" || !session?.isOperator) return <NotFound />;
  return <>{children}</>;
}

export function ConciergeShell({ children, back }: { children: ReactNode; back?: boolean }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-3 px-4">
          <Link to="/concierge" className="flex items-center gap-2 text-sm font-semibold">
            <Headset className="h-4 w-4 text-primary" />
            Concierge
          </Link>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Operator
          </span>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {back && (
              <Link to="/concierge" className="text-muted-foreground hover:text-foreground">
                All accounts
              </Link>
            )}
            <Link to="/" className="hidden text-muted-foreground hover:text-foreground sm:inline">
              Back to app
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-5 sm:py-6">{children}</main>
    </div>
  );
}

const SLA_STYLES: Record<SlaLevel, string> = {
  green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  red: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

export function SlaBadge({ account, className }: { account: Pick<ConciergeAccountSummary, "sla" | "hoursSincePurchase" | "isLive">; className?: string }) {
  if (account.isLive) {
    return (
      <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold", SLA_STYLES.green, className)}>
        Live
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums", SLA_STYLES[account.sla], className)}
      title="Time since purchase"
    >
      {formatAge(account.hoursSincePurchase)}
    </span>
  );
}

export function ProgressDots({ steps, className }: { steps: ConciergeStepDot[]; className?: string }) {
  if (steps.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-label={`${steps.filter((s) => s.done).length} of ${steps.length} steps done`}>
      {steps.map((s) => (
        <span
          key={s.key}
          title={`${s.title}${s.done ? " — done" : ""}`}
          className={cn("h-2.5 w-2.5 rounded-full", s.done ? "bg-emerald-500" : "bg-muted-foreground/25")}
        />
      ))}
    </span>
  );
}

export function TierBadge({ tier }: { tier: string | null }) {
  return (
    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      {tierLabel(tier)}
    </span>
  );
}

/** Tap to call / tap to text. Stops propagation so it works inside a clickable row. */
export function PhoneLinks({ phone, size = "sm" }: { phone: string | null; size?: "sm" | "lg" }) {
  if (!phone) return <span className="text-sm text-muted-foreground">No phone</span>;
  const big = size === "lg";
  const btn = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-border font-medium transition-colors hover:bg-muted",
    big ? "h-11 px-4 text-base" : "h-8 px-2.5 text-xs",
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <a href={`tel:${phone}`} className={cn(btn, big && "bg-primary text-primary-foreground border-primary hover:bg-primary/90")}>
        <Phone className={big ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {prettyPhone(phone)}
      </a>
      <a href={`sms:${phone}`} className={btn} aria-label="Text">
        <MessageSquare className={big ? "h-4 w-4" : "h-3.5 w-3.5"} />
        Text
      </a>
    </span>
  );
}
