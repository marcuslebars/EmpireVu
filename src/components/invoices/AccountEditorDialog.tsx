import { useState } from "react";
import { Building2, Loader2 } from "lucide-react";

import { AccountDialogShell } from "@/components/invoices/AccountDialogShell";
import { toast } from "@/components/ui/sonner";
import { inputCls, labelCls, selectCls, errorMessage } from "@/components/invoices/invoice-ui";
import {
  ACCOUNT_TERM_PRESETS,
  choiceToTerms,
  termsToChoice,
  accountTermsLabel,
  type AccountTermsChoice,
} from "@/components/invoices/AccountTerms";
import { useCreateCustomerAccount, useUpdateCustomerAccount } from "@/lib/invoice-hooks";
import type { CustomerAccount, CustomerAccountPayload } from "@/lib/invoices-api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create or edit a business account. Pass `account` to edit; omit it to create
 * (new accounts default to Net 30 — marinas rarely pay on receipt).
 * When `onSaved` is given it replaces the automatic close: the caller unmounts the dialog.
 */
export function AccountEditorDialog({
  orgId,
  account,
  initialName,
  onClose,
  onSaved,
}: {
  orgId: string;
  account?: CustomerAccount | null;
  initialName?: string;
  onClose: () => void;
  onSaved?: (account: CustomerAccount) => void;
}) {
  const isEdit = Boolean(account);
  const create = useCreateCustomerAccount(orgId);
  const update = useUpdateCustomerAccount(orgId);
  const pending = create.isPending || update.isPending;

  const [name, setName] = useState(account?.name ?? initialName ?? "");
  const [billingEmail, setBillingEmail] = useState(account?.billing_email ?? "");
  const [billingPhone, setBillingPhone] = useState(account?.billing_phone ?? "");
  const [billingAddress, setBillingAddress] = useState(account?.billing_address ?? "");
  const [taxNumber, setTaxNumber] = useState(account?.tax_number ?? "");
  const [terms, setTerms] = useState<AccountTermsChoice>(account ? termsToChoice(account.payment_terms_days) : "30");
  const [customDays, setCustomDays] = useState(
    account && termsToChoice(account.payment_terms_days) === "custom" ? String(account.payment_terms_days) : "",
  );
  const [notes, setNotes] = useState(account?.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Give the business a name.");
      return;
    }
    if (billingEmail.trim() && !EMAIL_RE.test(billingEmail.trim())) {
      setError("That billing email doesn't look right.");
      return;
    }
    const paymentTermsDays = choiceToTerms(terms, customDays);
    if (paymentTermsDays === undefined) {
      setError("Custom terms must be a whole number of days between 0 and 365.");
      return;
    }
    const payload: CustomerAccountPayload = {
      name: name.trim(),
      billingEmail: billingEmail.trim() || null,
      billingPhone: billingPhone.trim() || null,
      billingAddress: billingAddress.trim() || null,
      taxNumber: taxNumber.trim() || null,
      paymentTermsDays,
      notes: notes.trim() || null,
    };
    try {
      const saved = account
        ? await update.mutateAsync({ accountId: account.id, payload })
        : await create.mutateAsync(payload);
      toast.success(account ? "Business account updated" : `${saved.name} added`);
      // With onSaved the caller decides what happens next (and closes the dialog).
      if (onSaved) onSaved(saved);
      else onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the business account."));
    }
  };

  return (
    <AccountDialogShell
      title={isEdit ? "Edit business account" : "New business account"}
      description="Who the invoice is addressed to. People at the business stay ordinary contacts."
      icon={<Building2 className="w-4 h-4" />}
      size="lg"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        <div>
          <label className={labelCls}>
            Name <span className="text-destructive">*</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={200}
            placeholder="Bayview Marina"
            className={inputCls}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Billing email</label>
            <input
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              placeholder="accounts@bayviewmarina.ca"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Billing phone</label>
            <input
              type="tel"
              value={billingPhone}
              onChange={(e) => setBillingPhone(e.target.value)}
              maxLength={40}
              placeholder="705-555-0100"
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>Billing address</label>
          <textarea
            value={billingAddress}
            onChange={(e) => setBillingAddress(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={"123 Harbour Rd\nMidland, ON L4R 1A1"}
            className={`${inputCls} resize-y`}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Their GST/HST number</label>
            <input
              value={taxNumber}
              onChange={(e) => setTaxNumber(e.target.value)}
              maxLength={60}
              placeholder="123456789 RT0001"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Payment terms</label>
            <div className="flex gap-2">
              <select value={terms} onChange={(e) => setTerms(e.target.value as AccountTermsChoice)} className={selectCls}>
                <option value="default">Company default</option>
                {ACCOUNT_TERM_PRESETS.map((d) => (
                  <option key={d} value={String(d)}>
                    {accountTermsLabel(d)}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {terms === "custom" && (
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                  placeholder="Days"
                  aria-label="Custom payment terms in days"
                  className={`${inputCls} w-24 shrink-0`}
                />
              )}
            </div>
          </div>
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="PO required on every invoice, send to the GM…"
            className={`${inputCls} resize-y`}
          />
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 text-xs text-destructive">{error}</div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {isEdit ? "Save changes" : "Create account"}
          </button>
        </div>
      </form>
    </AccountDialogShell>
  );
}
