import { cn } from "@/lib/utils";

import { QUOTE_STATUS_LABELS, asQuoteStatus, type QuoteStatus } from "./quote-ui";

const STATUS_STYLE: Record<QuoteStatus, string> = {
  draft: "bg-secondary text-muted-foreground border-border",
  sent: "bg-[hsl(var(--accent-blue))]/10 text-[hsl(var(--accent-blue))] border-[hsl(var(--accent-blue))]/20",
  viewed: "bg-[hsl(var(--accent-violet))]/10 text-[hsl(var(--accent-violet))] border-[hsl(var(--accent-violet))]/20",
  approved: "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] border-[hsl(var(--warning))]/20",
  deposit_paid: "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))] border-[hsl(var(--success))]/20",
  completed: "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))] border-[hsl(var(--success))]/20",
  expired: "bg-secondary text-muted-foreground border-border",
  cancelled: "bg-secondary text-muted-foreground border-border line-through",
};

/** Status pill for a quote (same shape as InvoiceStatusBadge). */
export function QuoteStatusBadge({ status, className }: { status: string; className?: string }) {
  const s = asQuoteStatus(status);
  return (
    <span
      className={cn(
        "inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border whitespace-nowrap",
        STATUS_STYLE[s],
        className,
      )}
    >
      {QUOTE_STATUS_LABELS[s]}
    </span>
  );
}
