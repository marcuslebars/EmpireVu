/**
 * Confirm + deliver an invoice. Sending a draft issues it (number, issue/due
 * dates); re-sending an open invoice just re-delivers it. Delivery failures don't
 * fail the send — they come back as warnings.
 */
import { useState } from "react";
import { Loader2, Send, X } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/sonner";
import { useSendInvoice } from "@/lib/invoice-hooks";
import { formatCents, type Invoice } from "@/lib/invoices-api";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

import { errorMessage, primaryBtnCls, secondaryBtnCls, toastDeliveryOutcomes } from "./invoice-ui";

export function SendInvoiceDialog({
  invoice,
  onClose,
  onSent,
}: {
  invoice: Invoice;
  onClose: () => void;
  onSent?: (invoice: Invoice) => void;
}) {
  const orgId = useOrgId();
  const send = useSendInvoice(orgId);
  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDraft = invoice.status === "draft";
  const to = invoice.bill_to;

  async function handleSend() {
    setError(null);
    try {
      const result = await send.mutateAsync({ invoiceId: invoice.id, email, sms });
      const label = `Invoice ${result.invoice.invoice_number ?? ""}`.trim();
      toastDeliveryOutcomes(label, result.email, result.sms);
      onSent?.(result.invoice);
      onClose();
    } catch (err) {
      const msg = errorMessage(err, "Couldn't send the invoice.");
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <Modal onClose={onClose} size="md">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h2 className="text-base font-semibold text-foreground">{isDraft ? "Send invoice" : "Resend invoice"}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isDraft
              ? "This gives it a number and starts the payment terms."
              : `${invoice.invoice_number ?? "Invoice"} · balance ${formatCents(invoice.balance_due_cents, invoice.currency)}`}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-6 space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--accent-blue))]" />
          <span>
            <span className="block text-sm text-foreground">Email the invoice (PDF attached)</span>
            <span className={cn("block text-xs", to.email ? "text-muted-foreground" : "text-[hsl(var(--warning))]")}>
              {to.email ?? "No email address on file for this customer"}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--accent-blue))]" />
          <span>
            <span className="block text-sm text-foreground">Also text the pay link</span>
            <span className={cn("block text-xs", to.phone ? "text-muted-foreground" : "text-[hsl(var(--warning))]")}>
              {to.phone ?? "No phone number on file for this customer"}
            </span>
          </span>
        </label>
        {!email && !sms && (
          <p className="text-xs text-muted-foreground">
            {isDraft ? "Nothing will be delivered — the invoice is issued and you can share the pay link yourself." : "Choose how to resend it."}
          </p>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className={cn(secondaryBtnCls, "flex-1")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={send.isPending || (!isDraft && !email && !sms)}
            className={cn(primaryBtnCls, "flex-1")}
          >
            {send.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {isDraft ? (email || sms ? "Send invoice" : "Issue without sending") : "Resend"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
