/**
 * Record money received outside the pay page (e-Transfer, cheque, cash, a card
 * terminal…). The server caps it at what's still owing and returns a clear error.
 */
import { useState } from "react";
import { Loader2, X } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/sonner";
import { useRecordInvoicePayment } from "@/lib/invoice-hooks";
import { formatCents, type Invoice, type PaymentMethod } from "@/lib/invoices-api";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

import { centsToInput, errorMessage, inputCls, labelCls, parseDollarsToCents, primaryBtnCls, secondaryBtnCls, selectCls, todayYmd } from "./invoice-ui";

const METHODS: Array<{ value: PaymentMethod; label: string }> = [
  { value: "etransfer", label: "e-Transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card (terminal)" },
  { value: "bank_debit", label: "Bank debit" },
  { value: "other", label: "Other" },
];

/** YYYY-MM-DD (local) → ISO with offset, at local noon so the day never shifts. */
function ymdToIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

export function RecordPaymentDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const orgId = useOrgId();
  const record = useRecordInvoicePayment(orgId);
  const outstanding = Math.max(invoice.balance_due_cents - invoice.pending_payment_cents, 0);

  const [amount, setAmount] = useState(outstanding > 0 ? centsToInput(outstanding) : "");
  const [method, setMethod] = useState<PaymentMethod>("etransfer");
  const [receivedOn, setReceivedOn] = useState(todayYmd());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [sendReceipt, setSendReceipt] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cents = parseDollarsToCents(amount);
    if (cents === null || cents <= 0) {
      setError("Enter the amount received.");
      return;
    }
    if (!receivedOn) {
      setError("Enter the date the payment was received.");
      return;
    }
    try {
      const result = await record.mutateAsync({
        invoiceId: invoice.id,
        payload: {
          amountCents: cents,
          method,
          receivedAt: ymdToIso(receivedOn),
          reference: reference.trim() || null,
          notes: notes.trim() || null,
          sendReceipt,
        },
      });
      toast.success(
        result.invoice.status === "paid"
          ? `Payment recorded — ${result.invoice.invoice_number ?? "invoice"} is paid in full`
          : `Payment of ${formatCents(cents, invoice.currency)} recorded`,
      );
      if (result.receipt && !result.receipt.delivered) {
        toast.warning(`Receipt not emailed: ${result.receipt.reason ?? "unknown reason"}.`);
      }
      onClose();
    } catch (err) {
      const msg = errorMessage(err, "Couldn't record the payment.");
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <Modal onClose={onClose} size="md">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h2 className="text-base font-semibold text-foreground">Record payment</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {invoice.invoice_number ?? "Invoice"} · {formatCents(outstanding, invoice.currency)} still owing
            {invoice.pending_payment_cents > 0 && ` (${formatCents(invoice.pending_payment_cents, invoice.currency)} clearing)`}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>
              Amount <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={cn(inputCls, "pl-6")}
                autoFocus
              />
            </div>
          </div>
          <div>
            <label className={labelCls}>Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={selectCls}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Date received</label>
            <input type="date" value={receivedOn} max={todayYmd()} onChange={(e) => setReceivedOn(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Reference</label>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e-Transfer ref / cheque #"
              maxLength={200}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} className={cn(inputCls, "resize-none")} />
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={sendReceipt}
            onChange={(e) => setSendReceipt(e.target.checked)}
            className="h-4 w-4 accent-[hsl(var(--accent-blue))]"
          />
          <span className="text-sm text-foreground">Email a receipt to the customer</span>
        </label>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className={cn(secondaryBtnCls, "flex-1")}>
            Cancel
          </button>
          <button type="submit" disabled={record.isPending} className={cn(primaryBtnCls, "flex-1")}>
            {record.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Record payment
          </button>
        </div>
      </form>
    </Modal>
  );
}
