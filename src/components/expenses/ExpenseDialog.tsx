import { useMemo, useRef, useState } from "react";
import { Camera, FileText, Loader2, Receipt, Sparkles, Trash2, X } from "lucide-react";

import { SyncBadge } from "@/components/accounting/SyncBadge";
import { AccountDialogShell } from "@/components/invoices/AccountDialogShell";
import { centsToInput, errorMessage, inputCls, labelCls, parseDollarsToCents, primaryBtnCls, secondaryBtnCls, selectCls, todayYmd } from "@/components/invoices/invoice-ui";
import { toast } from "@/components/ui/sonner";
import { useCompanies } from "@/lib/api-hooks";
import { ApiError } from "@/lib/api-client";
import {
  EXPENSE_CATEGORIES,
  scanReceipt,
  uploadReceipt,
  useDeleteExpense,
  useSaveExpense,
  type Expense,
  type ExpenseCategory,
  type ReceiptType,
} from "@/lib/expenses-api";
import { useJobs } from "@/lib/job-hooks";
import { cn } from "@/lib/utils";

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

type Receipt = { path: string; type: ReceiptType; previewUrl: string | null } | null;

/**
 * Add / edit one expense. Snapping a receipt uploads it and (when AI is set up) reads it
 * to fill in the blanks — the person always sees and saves the values themselves.
 * `job` pins the expense to a job (opened from the job sheet).
 */
export function ExpenseDialog({
  orgId,
  expense,
  job,
  manager,
  onClose,
}: {
  orgId: string;
  expense: Expense | null;
  job?: { id: string; title: string } | null;
  manager: boolean;
  onClose: () => void;
}) {
  const save = useSaveExpense(orgId);
  const remove = useDeleteExpense(orgId);
  const { data: companies = [] } = useCompanies(orgId);
  const range = useMemo(() => ({ from: addDays(new Date(), -90).toISOString(), to: addDays(new Date(), 30).toISOString() }), []);
  const { data: jobs = [] } = useJobs(orgId, { scope: manager ? "all" : "mine", ...range, includeDone: true }, !job);
  const fileRef = useRef<HTMLInputElement>(null);

  const readOnly = Boolean(expense && !expense.canEdit);
  const [receipt, setReceipt] = useState<Receipt>(
    expense?.receiptType ? { path: "", type: expense.receiptType, previewUrl: expense.receiptUrl } : null,
  );
  const [receiptChanged, setReceiptChanged] = useState(false);
  const [busy, setBusy] = useState<"upload" | "scan" | null>(null);
  const [scanned, setScanned] = useState(false);
  const [spentOn, setSpentOn] = useState(expense?.spentOn ?? todayYmd());
  const [amount, setAmount] = useState(expense ? centsToInput(expense.amountCents) : "");
  const [tax, setTax] = useState(expense && expense.taxCents > 0 ? centsToInput(expense.taxCents) : "");
  const [vendor, setVendor] = useState(expense?.vendor ?? "");
  const [description, setDescription] = useState(expense?.description ?? "");
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? (job ? "materials" : "other"));
  const [bookingId, setBookingId] = useState(job?.id ?? expense?.bookingId ?? "");
  const [companyId, setCompanyId] = useState(expense?.companyId ?? "");
  const [paidWith, setPaidWith] = useState<"business" | "personal">(expense?.paidWith ?? "business");
  const [billable, setBillable] = useState(expense?.billable ?? false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(new Set<string>());
  const touch = (k: string) => touched.current.add(k);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy("upload");
    try {
      const up = await uploadReceipt(orgId, file);
      setReceipt({ ...up, previewUrl: up.type === "image/jpeg" ? URL.createObjectURL(file) : null });
      setReceiptChanged(true);
      setBusy("scan");
      try {
        const s = await scanReceipt(orgId, up.path);
        // Fill only what the person hasn't typed themselves.
        if (s.amountCents !== null && !touched.current.has("amount")) setAmount(centsToInput(s.amountCents));
        if (s.taxCents !== null && !touched.current.has("tax")) setTax(s.taxCents > 0 ? centsToInput(s.taxCents) : "");
        if (s.spentOn && !touched.current.has("date")) setSpentOn(s.spentOn);
        if (s.vendor && !touched.current.has("vendor")) setVendor(s.vendor);
        if (s.description && !touched.current.has("description")) setDescription(s.description);
        if (s.category && !touched.current.has("category")) setCategory(s.category);
        setScanned(Boolean(s.amountCents || s.vendor));
      } catch (err) {
        // AI not set up / couldn't read it: the receipt is still attached; fill in by hand.
        if (!(err instanceof ApiError && err.status === 503)) toast.message("Couldn't read that receipt — fill the details in by hand.");
      }
    } catch (err) {
      setError(errorMessage(err, "Couldn't upload that receipt."));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onSave = async () => {
    setError(null);
    const amountCents = parseDollarsToCents(amount);
    const taxCents = tax.trim() ? parseDollarsToCents(tax) : 0;
    if (amountCents === null || amountCents <= 0) return setError("Enter what it cost, like 45.20.");
    if (taxCents === null || taxCents < 0) return setError("Enter the tax like 5.20, or leave it blank.");
    if (taxCents > amountCents) return setError("Tax can't be more than the total.");
    if (!spentOn) return setError("Pick the date.");
    const onJob = bookingId || null;
    try {
      await save.mutateAsync({
        id: expense?.id,
        payload: {
          spentOn,
          vendor: vendor.trim() || null,
          description: description.trim() || null,
          category,
          amountCents,
          taxCents,
          paidWith,
          billable: Boolean(onJob) && billable,
          bookingId: onJob,
          companyId: onJob ? null : companyId || null,
          ...(expense && !receiptChanged ? {} : { receipt: receipt ? { path: receipt.path, type: receipt.type } : null }),
        },
      });
      toast.success(expense ? "Expense updated" : "Expense added");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const onDelete = async () => {
    if (!expense) return;
    try {
      await remove.mutateAsync(expense.id);
      toast.success("Expense deleted");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const billed = Boolean(expense?.billedInvoiceId);

  return (
    <AccountDialogShell title={expense ? (readOnly ? "Expense" : "Edit expense") : "Add expense"} icon={<Receipt className="w-4 h-4" />} onClose={onClose}>
      <div className="px-6 py-5 space-y-4">
        {/* Receipt */}
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            aria-label="Receipt file"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          {receipt ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 p-2">
              {receipt.previewUrl && receipt.type === "image/jpeg" ? (
                <a href={receipt.previewUrl} target="_blank" rel="noreferrer" className="shrink-0">
                  <img src={receipt.previewUrl} alt="Receipt" className="w-14 h-14 rounded-md object-cover border border-border" />
                </a>
              ) : (
                <a
                  href={receipt.previewUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="w-14 h-14 rounded-md border border-border bg-card flex items-center justify-center text-muted-foreground shrink-0"
                >
                  <FileText className="w-6 h-6" />
                </a>
              )}
              <div className="flex-1 min-w-0 text-sm">
                <p className="font-medium text-foreground">Receipt attached</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  {busy === "scan" ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" /> Reading it…
                    </>
                  ) : scanned ? (
                    <>
                      <Sparkles className="w-3 h-3 text-primary" /> Details filled in from the receipt — check them.
                    </>
                  ) : (
                    "Kept with this expense for your records."
                  )}
                </p>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  aria-label="Remove receipt"
                  onClick={() => {
                    setReceipt(null);
                    setReceiptChanged(true);
                    setScanned(false);
                  }}
                  className="p-1.5 text-muted-foreground hover:text-destructive"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ) : (
            !readOnly && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy !== null}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-secondary/30 hover:bg-secondary/60 px-4 py-4 text-sm font-medium text-foreground disabled:opacity-60"
              >
                {busy === "upload" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                {busy === "upload" ? "Uploading…" : "Snap or upload the receipt"}
              </button>
            )
          )}
        </div>

        <fieldset disabled={readOnly} className="space-y-3 disabled:opacity-80">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls} htmlFor="exp-amount">
                Total paid
              </label>
              <input
                id="exp-amount"
                value={amount}
                onChange={(e) => {
                  touch("amount");
                  setAmount(e.target.value);
                }}
                inputMode="decimal"
                placeholder="$0.00"
                className={cn(inputCls, "text-right")}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="exp-tax">
                Tax in it
              </label>
              <input
                id="exp-tax"
                value={tax}
                onChange={(e) => {
                  touch("tax");
                  setTax(e.target.value);
                }}
                inputMode="decimal"
                placeholder="$0.00"
                className={cn(inputCls, "text-right")}
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className={labelCls} htmlFor="exp-date">
                Date
              </label>
              <input
                id="exp-date"
                type="date"
                value={spentOn}
                onChange={(e) => {
                  touch("date");
                  setSpentOn(e.target.value);
                }}
                className={inputCls}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="exp-vendor">
                Where
              </label>
              <input
                id="exp-vendor"
                value={vendor}
                onChange={(e) => {
                  touch("vendor");
                  setVendor(e.target.value);
                }}
                maxLength={200}
                placeholder="e.g. Home Depot"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="exp-category">
                Category
              </label>
              <select
                id="exp-category"
                value={category}
                onChange={(e) => {
                  touch("category");
                  setCategory(e.target.value as ExpenseCategory);
                }}
                className={selectCls}
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="exp-desc">
              What for
            </label>
            <input
              id="exp-desc"
              value={description}
              onChange={(e) => {
                touch("description");
                setDescription(e.target.value);
              }}
              maxLength={1000}
              placeholder="e.g. Shrink wrap and tape"
              className={inputCls}
            />
          </div>

          {job ? (
            <p className="text-xs text-muted-foreground">
              On job: <span className="text-foreground font-medium">{job.title}</span>
            </p>
          ) : (
            <div className={cn("grid gap-3", !bookingId && companies.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
              <div>
                <label className={labelCls} htmlFor="exp-job">
                  Job
                </label>
                <select id="exp-job" value={bookingId} onChange={(e) => setBookingId(e.target.value)} className={selectCls}>
                  <option value="">Not for a job (overhead)</option>
                  {expense?.bookingId && !jobs.some((j) => j.id === expense.bookingId) && <option value={expense.bookingId}>{expense.jobTitle ?? "This job"}</option>}
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {new Date(j.scheduledFor).toLocaleDateString("en-CA", { month: "short", day: "numeric" })} · {j.title}
                      {j.contactName ? ` — ${j.contactName}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              {!bookingId && companies.length > 1 && (
                <div>
                  <label className={labelCls} htmlFor="exp-company">
                    Business
                  </label>
                  <select id="exp-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={selectCls}>
                    <option value="">Shared / not sure</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div>
            <span className={labelCls}>Paid with</span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Paid with">
              {(
                [
                  ["business", "Business money"],
                  ["personal", "My own money"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={paidWith === value}
                  onClick={() => setPaidWith(value)}
                  className={cn(
                    "h-10 rounded-lg border text-sm font-medium transition-colors",
                    paidWith === value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-secondary text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {paidWith === "personal" && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                {expense?.reimbursedAt
                  ? `Paid back ${new Date(expense.reimbursedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}.`
                  : "Shows as owed to you until an owner marks it paid back."}
              </p>
            )}
          </div>

          {bookingId && (
            <label className="flex items-start gap-2.5 text-sm cursor-pointer">
              <input type="checkbox" checked={billable} disabled={billed} onChange={(e) => setBillable(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
              <span>
                <span className="text-foreground font-medium">Bill this to the customer</span>
                <span className="block text-xs text-muted-foreground">
                  {billed
                    ? `Billed on invoice ${expense?.billedInvoiceNumber ?? "(draft)"}.`
                    : "Added to the job's invoice at cost, before tax, when the invoice is made."}
                </span>
              </span>
            </label>
          )}
        </fieldset>

        {expense && manager && <SyncBadge orgId={orgId} companyId={expense.companyId} type="expense" id={expense.id} />}
        {readOnly && (
          <p className="text-xs text-muted-foreground">
            {expense?.reimbursedAt || billed ? "This expense has been paid back or billed, so only an owner or admin can change it." : "Only the person who logged this can change it."}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-border">
        {expense && !readOnly ? (
          <button type="button" onClick={() => void onDelete()} disabled={remove.isPending} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive">
            {remove.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={secondaryBtnCls}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button type="button" onClick={() => void onSave()} disabled={save.isPending || busy !== null} className={primaryBtnCls}>
              {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
            </button>
          )}
        </div>
      </div>
    </AccountDialogShell>
  );
}
