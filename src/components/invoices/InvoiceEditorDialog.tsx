/**
 * Create / edit an invoice (drafts, and sent invoices with no money against them).
 * Totals are previewed client-side with the same rounding the server uses; the
 * server is authoritative and its validation messages are shown as-is.
 */
import { useEffect, useMemo, useState } from "react";
import { Building2, Loader2, Plus, Search, Send, Trash2, User, X } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/sonner";
import { useCompanies, useCRMContacts } from "@/lib/api-hooks";
import { useCreateInvoice, useCustomerAccounts, useUpdateInvoice } from "@/lib/invoice-hooks";
import { formatCents, type Invoice, type InvoiceWritePayload } from "@/lib/invoices-api";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";

import {
  centsToInput,
  errorMessage,
  inputCls,
  labelCls,
  parseDollarsToCents,
  primaryBtnCls,
  secondaryBtnCls,
  selectCls,
} from "./invoice-ui";

// ─── Money preview (mirrors src/server/services/invoices/math.ts) ────────────

function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function lineAmountCents(quantity: number, unitPriceCents: number): number {
  const hundredths = Math.round((Math.round(quantity * 100) / 100) * 100);
  return roundHalfAway((hundredths * unitPriceCents) / 100);
}

function taxCentsFor(subtotalCents: number, taxRateBps: number): number {
  if (subtotalCents <= 0 || taxRateBps <= 0) return 0;
  return Math.floor((subtotalCents * taxRateBps + 5_000) / 10_000);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// ─── Form model ──────────────────────────────────────────────────────────────

interface LineDraft {
  key: number;
  label: string;
  description: string;
  showDetails: boolean;
  quantity: string;
  unitPrice: string;
}

const TERMS: Array<{ days: number; label: string }> = [
  { days: 0, label: "Due on receipt" },
  { days: 7, label: "Net 7" },
  { days: 15, label: "Net 15" },
  { days: 30, label: "Net 30" },
  { days: 45, label: "Net 45" },
  { days: 60, label: "Net 60" },
];

/** "default" = let the server pick (account terms, else company default). */
type TermsChoice = "default" | "date" | `${number}`;

let lineKeySeq = 0;
const nextKey = () => ++lineKeySeq;

function blankLine(): LineDraft {
  return { key: nextKey(), label: "", description: "", showDetails: false, quantity: "1", unitPrice: "" };
}

function initialTerms(invoice: Invoice | undefined): TermsChoice {
  if (!invoice) return "default";
  if (invoice.status === "draft") return invoice.due_date ? "date" : (`${invoice.payment_terms_days}` as TermsChoice);
  // Issued: the due date is always stamped. It's a "specific date" when it
  // doesn't follow from the issue date + terms.
  if (invoice.issue_date && invoice.due_date && addDaysYmd(invoice.issue_date, invoice.payment_terms_days) !== invoice.due_date) {
    return "date";
  }
  return `${invoice.payment_terms_days}` as TermsChoice;
}

// ─── Contact picker ──────────────────────────────────────────────────────────

export function ContactSearch({
  orgId,
  value,
  label,
  onChange,
}: {
  orgId: string;
  value: string | null;
  label: string;
  onChange: (id: string | null, label: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isFetching } = useCRMContacts(orgId, { search: debounced || undefined, pageSize: 8 });
  const contacts = open ? data?.rows?.items ?? [] : [];

  if (value) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-secondary border border-border rounded-lg">
        <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm text-foreground truncate flex-1">{label || "Selected contact"}</span>
        <button
          type="button"
          onClick={() => onChange(null, "")}
          className="p-0.5 rounded hover:bg-background text-muted-foreground"
          aria-label="Clear contact"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search contacts by name, email or phone…"
        className={cn(inputCls, "pl-9")}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-xl z-50 py-1 max-h-64 overflow-y-auto custom-scrollbar">
            {contacts.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground text-center">
                {isFetching ? "Searching…" : "No matching contacts."}
              </p>
            ) : (
              contacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onChange(c.id, c.name);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-secondary transition-colors"
                >
                  <p className="text-sm text-foreground truncate">{c.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {[c.email, c.phone, c.company?.name].filter(Boolean).join(" · ") || "No contact details"}
                  </p>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Dialog ──────────────────────────────────────────────────────────────────

export function InvoiceEditorDialog({
  invoice,
  onClose,
  onSaved,
}: {
  /** Present when editing; absent when creating. */
  invoice?: Invoice;
  onClose: () => void;
  /** Called with the saved invoice; `send` when the user chose "Save & send". */
  onSaved: (invoice: Invoice, opts: { send: boolean }) => void;
}) {
  const { organizationId: orgId, companyId: ctxCompanyId } = useOrg();
  const { data: companies } = useCompanies(orgId);
  const { data: accounts, isLoading: accountsLoading } = useCustomerAccounts(orgId);
  const createInvoice = useCreateInvoice(orgId);
  const updateInvoice = useUpdateInvoice(orgId);
  const isEdit = Boolean(invoice);
  const isDraft = !invoice || invoice.status === "draft";

  const [companyId, setCompanyId] = useState(invoice?.company_id ?? ctxCompanyId ?? "");
  const [customerType, setCustomerType] = useState<"person" | "business">(invoice?.customer_account_id ? "business" : "person");
  const [contactId, setContactId] = useState<string | null>(invoice?.contact_id ?? null);
  const [contactLabel, setContactLabel] = useState(
    invoice ? (invoice.customer_account_id ? invoice.bill_to.attention ?? "" : invoice.contact_id ? invoice.bill_to.name : "") : "",
  );
  const [accountId, setAccountId] = useState(invoice?.customer_account_id ?? "");
  const [title, setTitle] = useState(invoice?.title ?? "");
  const [lines, setLines] = useState<LineDraft[]>(() =>
    invoice && invoice.line_items.length > 0
      ? invoice.line_items.map((l) => ({
          key: nextKey(),
          label: l.label,
          description: l.description ?? "",
          showDetails: Boolean(l.description),
          quantity: String(l.quantity),
          unitPrice: centsToInput(l.unitPriceCents),
        }))
      : [blankLine()],
  );
  const [taxPct, setTaxPct] = useState(invoice ? String(invoice.tax_rate_bps / 100) : "13");
  const [credit, setCredit] = useState(invoice && invoice.credit_cents > 0 ? centsToInput(invoice.credit_cents) : "");
  const [terms, setTerms] = useState<TermsChoice>(() => initialTerms(invoice));
  const [dueDate, setDueDate] = useState(invoice?.due_date ?? "");
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const [internalNotes, setInternalNotes] = useState(invoice?.internal_notes ?? "");
  const originalAddress = invoice?.bill_to.address ?? "";
  const [billToAddress, setBillToAddress] = useState(originalAddress);
  const [error, setError] = useState<string | null>(null);
  const [sendIntent, setSendIntent] = useState(false);

  // Default to the first company once they load.
  useEffect(() => {
    if (!companyId && companies && companies.length > 0) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  // Switching who it's billed to drops an address carried over from the old customer.
  const resetAddressIfUntouched = () => {
    if (billToAddress === originalAddress) setBillToAddress("");
  };

  const termOptions = useMemo(() => {
    const opts = [...TERMS];
    if (invoice && !opts.some((t) => t.days === invoice.payment_terms_days)) {
      opts.push({ days: invoice.payment_terms_days, label: `Net ${invoice.payment_terms_days}` });
      opts.sort((a, b) => a.days - b.days);
    }
    return opts;
  }, [invoice]);

  // ── Live preview ──
  const taxRateBps = Math.round((Number(taxPct) || 0) * 100);
  const preview = useMemo(() => {
    let subtotal = 0;
    for (const l of lines) {
      const qty = Number(l.quantity);
      const unit = parseDollarsToCents(l.unitPrice) ?? 0;
      if (Number.isFinite(qty) && qty > 0) subtotal += lineAmountCents(qty, unit);
    }
    const tax = taxCentsFor(subtotal, taxRateBps);
    const creditCents = parseDollarsToCents(credit) ?? 0;
    return { subtotal, tax, total: subtotal + tax, credit: creditCents, due: Math.max(subtotal + tax - creditCents, 0) };
  }, [lines, taxRateBps, credit]);

  const updateLine = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const isPending = createInvoice.isPending || updateInvoice.isPending;

  /**
   * `draft`: save whatever is there — no customer yet, blank lines, no prices. Only
   * numbers that can't be read are refused. `send`: everything must be complete
   * (the server checks again before an invoice goes out).
   */
  function buildPayload(mode: "draft" | "send"): InvoiceWritePayload | string {
    const strict = mode === "send" || !isDraft;
    if (!companyId) return "Choose the company this invoice is from.";
    if (strict && customerType === "person" && !contactId) return "Choose the contact this invoice is for.";
    if (strict && customerType === "business" && !accountId) return "Choose the business account this invoice is for.";

    const outLines: InvoiceWritePayload["lines"] = [];
    for (const [i, l] of lines.entries()) {
      const n = i + 1;
      const empty = !l.label.trim() && !l.unitPrice.trim() && (!l.quantity.trim() || l.quantity.trim() === "1") && !l.description.trim();
      if (!strict && empty) continue; // an untouched line isn't worth keeping on a draft
      if (strict && !l.label.trim()) return `Line ${n} needs a description.`;
      const qty = l.quantity.trim() === "" && !strict ? 1 : Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) return `Line ${n}: quantity must be above zero.`;
      const unit = l.unitPrice.trim() === "" && !strict ? 0 : parseDollarsToCents(l.unitPrice);
      if (unit === null) return `Line ${n}: enter a unit price (use 0 for no charge).`;
      outLines.push({
        label: l.label.trim(),
        description: l.showDetails && l.description.trim() ? l.description.trim() : null,
        quantity: Math.round(qty * 100) / 100,
        unitPriceCents: unit,
      });
    }
    if (strict && outLines.length === 0) return "Add at least one line.";

    const pct = Number(taxPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) return "Tax rate must be between 0% and 50%.";
    const creditCents = credit.trim() ? parseDollarsToCents(credit) : 0;
    if (creditCents === null || creditCents < 0) return "Enter the deposit / credit as a positive dollar amount.";

    if (strict && terms === "date" && !dueDate) return "Pick a due date, or choose payment terms instead.";

    const payload: InvoiceWritePayload = {
      title: title.trim() || null,
      lines: outLines,
      taxRateBps: Math.round(pct * 100),
      creditCents,
      notes: notes.trim() || null,
      internalNotes: internalNotes.trim() || null,
      billToAddress: billToAddress.trim() || null,
    };

    // Who it's billed to. On update the server does NOT re-derive a contact's
    // business account, so be explicit about both ids.
    if (customerType === "person") {
      payload.contactId = contactId;
      if (!contactId) payload.customerAccountId = null;
      // Create links the contact's business account itself; on edit, "Person"
      // means bill the person.
      if (isEdit) payload.customerAccountId = null;
    } else {
      payload.customerAccountId = accountId || null;
      // Keep the attention contact only if the account didn't change.
      payload.contactId = invoice && invoice.customer_account_id === accountId ? invoice.contact_id : null;
    }

    // Terms / due date.
    if (terms === "date") {
      payload.dueDate = dueDate || null;
    } else if (terms !== "default") {
      payload.paymentTermsDays = Number(terms);
      // Drafts get their due date when sent; an issued invoice's due date
      // follows its terms when we leave dueDate out.
      if (isDraft) payload.dueDate = null;
    }
    return payload;
  }

  async function submit(send: boolean) {
    setError(null);
    const built = buildPayload(send ? "send" : "draft");
    if (typeof built === "string") {
      setError(built);
      return;
    }
    setSendIntent(send);
    try {
      const saved = invoice
        ? await updateInvoice.mutateAsync({ invoiceId: invoice.id, payload: built })
        : await createInvoice.mutateAsync({ ...built, companyId });
      if (!send) toast.success(invoice ? "Invoice saved" : "Draft invoice created");
      onSaved(saved, { send });
    } catch (err) {
      const msg = errorMessage(err, "Couldn't save the invoice.");
      setError(msg);
      toast.error(msg);
    }
  }

  const companyName = companies?.find((c) => c.id === companyId)?.name;

  return (
    <Modal onClose={onClose} size="2xl">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {isEdit ? `Edit ${invoice?.invoice_number ?? "draft invoice"}` : "New invoice"}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isEdit && !isDraft
              ? "This invoice has been sent — saving updates the customer's copy and pay link."
              : "Save a draft any time, even half-finished, and send it when it’s ready."}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        className="p-4 sm:p-6 space-y-5"
      >
        {/* Company + customer */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>
              Company <span className="text-destructive">*</span>
            </label>
            {isEdit ? (
              <div className={cn(inputCls, "truncate")}>{companyName ?? "—"}</div>
            ) : (
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={selectCls} required>
                {!companies && <option value="">Loading companies…</option>}
                {companies?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className={labelCls}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Winter storage 2026/27"
              maxLength={300}
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Bill to <span className="text-xs font-normal text-muted-foreground">(needed to send)</span>
            </label>
            <div className="flex items-center gap-1 bg-secondary rounded-lg p-0.5">
              {(["person", "business"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    if (t !== customerType) resetAddressIfUntouched();
                    setCustomerType(t);
                  }}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                    customerType === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "person" ? <User className="w-3 h-3" /> : <Building2 className="w-3 h-3" />}
                  {t === "person" ? "Person" : "Business"}
                </button>
              ))}
            </div>
          </div>
          {customerType === "person" ? (
            <ContactSearch
              orgId={orgId}
              value={contactId}
              label={contactLabel}
              onChange={(id, label) => {
                if (id !== contactId) resetAddressIfUntouched();
                setContactId(id);
                setContactLabel(label);
              }}
            />
          ) : (
            <select
              value={accountId}
              onChange={(e) => {
                resetAddressIfUntouched();
                setAccountId(e.target.value);
              }}
              className={selectCls}
            >
              <option value="">{accountsLoading ? "Loading business accounts…" : "Choose a business account…"}</option>
              {accounts?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {customerType === "business" && !accountsLoading && (accounts?.length ?? 0) === 0 && (
            <p className="text-[11px] text-muted-foreground mt-1">No business accounts yet — add one from the business accounts screen.</p>
          )}
        </div>

        {/* Lines */}
        <div className="space-y-2">
          <div className="hidden sm:grid grid-cols-[1fr_5rem_7rem_6rem_2rem] gap-2 px-1">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Description</span>
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Qty</span>
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Unit price</span>
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider text-right">Amount</span>
            <span />
          </div>
          {lines.map((l, i) => {
            const qty = Number(l.quantity);
            const unit = parseDollarsToCents(l.unitPrice) ?? 0;
            const amount = Number.isFinite(qty) && qty > 0 ? lineAmountCents(qty, unit) : 0;
            return (
              <div key={l.key} className="rounded-lg border border-border/60 sm:border-0 p-2 sm:p-0 space-y-2">
                <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_5rem_7rem_6rem_2rem] gap-2 items-start">
                  <input
                    type="text"
                    value={l.label}
                    onChange={(e) => updateLine(l.key, { label: e.target.value })}
                    placeholder={i === 0 ? "e.g., Shrink wrap — 24 ft" : "Description"}
                    maxLength={300}
                    className={cn(inputCls, "col-span-1")}
                    aria-label={`Line ${i + 1} description`}
                  />
                  <button
                    type="button"
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))}
                    className="sm:hidden p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    aria-label={`Remove line ${i + 1}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <div className="col-span-2 sm:col-span-1 grid grid-cols-3 sm:contents gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                      className={inputCls}
                      aria-label={`Line ${i + 1} quantity`}
                      placeholder="Qty"
                    />
                    <div className="relative">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={l.unitPrice}
                        onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                        placeholder="0.00"
                        className={cn(inputCls, "pl-6")}
                        aria-label={`Line ${i + 1} unit price`}
                      />
                    </div>
                    <div className={cn("px-1 py-2 text-sm text-right tabular-nums", amount < 0 ? "text-[hsl(var(--success))]" : "text-foreground")}>
                      {formatCents(amount)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [blankLine()]))}
                    className="hidden sm:flex p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    aria-label={`Remove line ${i + 1}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {l.showDetails ? (
                  <textarea
                    value={l.description}
                    onChange={(e) => updateLine(l.key, { description: e.target.value })}
                    rows={2}
                    maxLength={2000}
                    placeholder="Optional details shown under the line"
                    className={cn(inputCls, "resize-none text-xs")}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => updateLine(l.key, { showDetails: true })}
                    className="text-[11px] text-muted-foreground hover:text-foreground px-1"
                  >
                    + Add details
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, blankLine()])}
            disabled={lines.length >= 100}
            className="flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Add line
          </button>
          <p className="text-[11px] text-muted-foreground">Tip: a negative unit price makes a discount line.</p>
        </div>

        {/* Tax, credit, totals */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Tax rate (%)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={taxPct}
                  onChange={(e) => setTaxPct(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Deposit / credit</label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={credit}
                    onChange={(e) => setCredit(e.target.value)}
                    placeholder="0.00"
                    className={cn(inputCls, "pl-6")}
                  />
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground -mt-1">Deposit or credit already received is taken off the amount due.</p>
            <div className={cn("grid gap-3", terms === "date" ? "grid-cols-2" : "grid-cols-1")}>
              <div>
                <label className={labelCls}>Payment terms</label>
                <select value={terms} onChange={(e) => setTerms(e.target.value as TermsChoice)} className={selectCls}>
                  {!isEdit && <option value="default">Default terms</option>}
                  {termOptions.map((t) => (
                    <option key={t.days} value={String(t.days)}>
                      {t.label}
                    </option>
                  ))}
                  <option value="date">Specific due date…</option>
                </select>
              </div>
              {terms === "date" && (
                <div>
                  <label className={labelCls}>Due date</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl bg-secondary/30 border border-border/50 p-4 space-y-1.5 text-sm self-start">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatCents(preview.subtotal)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Tax ({Number(taxPct) || 0}%)</span>
              <span className="tabular-nums">{formatCents(preview.tax)}</span>
            </div>
            <div className="flex justify-between font-semibold text-foreground border-t border-border pt-1.5">
              <span>Total</span>
              <span className="tabular-nums">{formatCents(preview.total)}</span>
            </div>
            {preview.credit > 0 && (
              <>
                <div className="flex justify-between text-muted-foreground">
                  <span>Deposit / credit</span>
                  <span className="tabular-nums">−{formatCents(preview.credit)}</span>
                </div>
                <div className="flex justify-between font-semibold text-foreground">
                  <span>Amount due</span>
                  <span className="tabular-nums">{formatCents(preview.due)}</span>
                </div>
              </>
            )}
            {preview.credit > preview.total && (
              <p className="text-[11px] text-destructive pt-1">The credit is more than the invoice total.</p>
            )}
            {preview.subtotal < 0 && <p className="text-[11px] text-destructive pt-1">The invoice total can't be negative.</p>}
          </div>
        </div>

        {/* Notes + address */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Notes for the customer</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder="Shown on the invoice and pay page"
              className={cn(inputCls, "resize-none")}
            />
          </div>
          <div>
            <label className={labelCls}>Internal notes</label>
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              rows={3}
              maxLength={5000}
              placeholder="Only your team sees these"
              className={cn(inputCls, "resize-none")}
            />
          </div>
        </div>
        <div>
          <label className={labelCls}>Bill-to address</label>
          <textarea
            value={billToAddress}
            onChange={(e) => setBillToAddress(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder={customerType === "business" ? "Leave blank to use the account's billing address" : "Optional mailing address"}
            className={cn(inputCls, "resize-none")}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row gap-2 pt-1">
          <button type="button" onClick={onClose} className={cn(secondaryBtnCls, "sm:flex-1")}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={cn(secondaryBtnCls, "sm:flex-1")}>
            {isPending && !sendIntent ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {isDraft ? "Save draft" : "Save changes"}
          </button>
          <button type="button" disabled={isPending} onClick={() => void submit(true)} className={cn(primaryBtnCls, "sm:flex-1")}>
            {isPending && sendIntent ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {isDraft ? "Save & send" : "Save, then resend…"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
