import { cn } from "@/lib/utils";
import { INVOICE_STATUS_LABELS, type InvoiceStatus } from "@/lib/invoices-api";

const STATUS_STYLE: Record<InvoiceStatus, string> = {
  draft: "bg-secondary text-muted-foreground border-border",
  sent: "bg-[hsl(var(--accent-blue))]/10 text-[hsl(var(--accent-blue))] border-[hsl(var(--accent-blue))]/20",
  viewed: "bg-[hsl(var(--accent-violet))]/10 text-[hsl(var(--accent-violet))] border-[hsl(var(--accent-violet))]/20",
  partially_paid: "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] border-[hsl(var(--warning))]/20",
  paid: "bg-[hsl(var(--success))]/10 text-[hsl(var(--success))] border-[hsl(var(--success))]/20",
  void: "bg-secondary text-muted-foreground border-border line-through",
};

/** Status pill for an invoice; `overdue` adds a red "Overdue" pill next to it. */
export function InvoiceStatusBadge({
  status,
  overdue,
  className,
}: {
  status: InvoiceStatus;
  overdue?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        className={cn(
          "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border whitespace-nowrap",
          STATUS_STYLE[status],
        )}
      >
        {INVOICE_STATUS_LABELS[status]}
      </span>
      {overdue && (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border whitespace-nowrap bg-destructive/10 text-destructive border-destructive/20">
          Overdue
        </span>
      )}
    </span>
  );
}
