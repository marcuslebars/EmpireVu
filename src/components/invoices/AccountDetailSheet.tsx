import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Building2,
  ChevronRight,
  Edit3,
  FileText,
  Loader2,
  Mail,
  Phone,
  Receipt,
  UserPlus,
  Users,
  X,
} from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { ErrorBanner } from "@/components/ui/StateViews";
import { InvoiceStatusBadge } from "@/components/invoices/InvoiceStatusBadge";
import { errorMessage, inputCls, labelCls, sectionLabelCls, selectCls } from "@/components/invoices/invoice-ui";
import { AccountEditorDialog } from "@/components/invoices/AccountEditorDialog";
import { AccountContactPicker } from "@/components/invoices/AccountContactPicker";
import { accountTermsLabel } from "@/components/invoices/AccountTerms";
import { useCompanies } from "@/lib/api-hooks";
import {
  useCustomerAccount,
  useInvoices,
  useLinkContactToAccount,
  useSendStatement,
  useUpdateCustomerAccount,
} from "@/lib/invoice-hooks";
import { formatCents, formatYmd, statementPdfUrl } from "@/lib/invoices-api";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Field({ label, value, multiline }: { label: string; value: string | null | undefined; multiline?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("text-sm text-foreground mt-0.5 break-words", multiline && "whitespace-pre-line", !value && "text-muted-foreground")}>
        {value || "—"}
      </p>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className={sectionLabelCls}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Business account detail: fields, linked contacts, invoices and statements. */
export function AccountDetailSheet({
  orgId,
  accountId,
  onClose,
}: {
  orgId: string;
  accountId: string | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={Boolean(accountId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl p-0 bg-card border-border overflow-y-auto">
        {accountId ? <AccountDetailBody orgId={orgId} accountId={accountId} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function AccountDetailBody({ orgId, accountId }: { orgId: string; accountId: string }) {
  const { data, isLoading, isError, refetch } = useCustomerAccount(orgId, accountId);
  const { data: invoiceData, isLoading: invoicesLoading } = useInvoices(orgId, { customerAccountId: accountId });
  const update = useUpdateCustomerAccount(orgId);
  const link = useLinkContactToAccount(orgId);

  const [editOpen, setEditOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const linkedIds = useMemo(() => new Set((data?.contacts ?? []).map((c) => c.id)), [data?.contacts]);

  if (isLoading) {
    return (
      <div className="p-6">
        <SheetTitle className="sr-only">Business account</SheetTitle>
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading business account…
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6 pt-12">
        <SheetTitle className="sr-only">Business account</SheetTitle>
        <ErrorBanner message="Couldn't load this business account." onRetry={() => refetch()} />
      </div>
    );
  }

  const { account, contacts } = data;
  const archived = Boolean(account.archived_at);
  const invoices = invoiceData?.invoices ?? [];
  const summary = invoiceData?.summary;

  const toggleArchive = () => {
    if (!archived && !window.confirm(`Archive ${account.name}? It will be hidden from the list; its invoices are kept.`)) return;
    update.mutate(
      { accountId: account.id, payload: { archived: !archived } },
      {
        onSuccess: () => toast.success(archived ? "Business account restored" : "Business account archived"),
        onError: (err) => toast.error(errorMessage(err, "Couldn't update the account.")),
      },
    );
  };

  const setLinked = (contactId: string, linked: boolean, name: string) => {
    link.mutate(
      { accountId: account.id, contactId, linked },
      {
        onSuccess: () => {
          toast.success(linked ? `${name} linked to ${account.name}` : `${name} unlinked`);
          if (linked) setPickerOpen(false);
        },
        onError: (err) => toast.error(errorMessage(err, "Couldn't update the contact.")),
      },
    );
  };

  const pendingContactId = link.isPending ? (link.variables?.contactId ?? null) : null;

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-5 border-b border-border pr-12">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Building2 className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <SheetTitle className="text-lg font-bold text-foreground truncate">{account.name}</SheetTitle>
              {archived && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                  Archived
                </span>
              )}
            </div>
            <SheetDescription className="text-xs text-muted-foreground mt-0.5">
              {accountTermsLabel(account.payment_terms_days)} · {contacts.length} contact{contacts.length === 1 ? "" : "s"}
            </SheetDescription>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <button
            onClick={() => setEditOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
          >
            <Edit3 className="w-3.5 h-3.5" /> Edit
          </button>
          <button
            onClick={toggleArchive}
            disabled={update.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {update.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : archived ? (
              <ArchiveRestore className="w-3.5 h-3.5" />
            ) : (
              <Archive className="w-3.5 h-3.5" />
            )}
            {archived ? "Unarchive" : "Archive"}
          </button>
        </div>
      </div>

      <div className="px-6 py-5 space-y-7">
        {/* Balance */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-secondary/40 border border-border rounded-xl p-3">
            <p className="text-[11px] text-muted-foreground">Open balance</p>
            <p className="text-lg font-bold text-foreground tabular-nums mt-0.5">
              {summary ? formatCents(summary.outstandingCents) : "—"}
            </p>
          </div>
          <div className="bg-secondary/40 border border-border rounded-xl p-3">
            <p className="text-[11px] text-muted-foreground">Overdue</p>
            <p
              className={cn(
                "text-lg font-bold tabular-nums mt-0.5",
                summary && summary.overdueCents > 0 ? "text-destructive" : "text-foreground",
              )}
            >
              {summary ? formatCents(summary.overdueCents) : "—"}
            </p>
          </div>
        </div>

        {/* Details */}
        <Section title="Billing details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
            <Field label="Billing email" value={account.billing_email} />
            <Field label="Billing phone" value={account.billing_phone} />
            <Field label="Billing address" value={account.billing_address} multiline />
            <Field label="GST/HST number" value={account.tax_number} />
            <Field label="Payment terms" value={accountTermsLabel(account.payment_terms_days)} />
          </div>
          {account.notes && (
            <div className="bg-secondary/40 border border-border rounded-lg px-3 py-2.5">
              <p className="text-[11px] text-muted-foreground mb-0.5">Notes</p>
              <p className="text-sm text-foreground whitespace-pre-line">{account.notes}</p>
            </div>
          )}
        </Section>

        {/* Contacts */}
        <Section
          title={`Contacts (${contacts.length})`}
          action={
            <button
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
            >
              <UserPlus className="w-3.5 h-3.5" /> Link contact
            </button>
          }
        >
          {contacts.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-3 bg-secondary/40 rounded-lg">
              <Users className="w-4 h-4 shrink-0" />
              No one linked yet. Link the people you deal with — invoicing them bills this business.
            </div>
          ) : (
            <div className="border border-border rounded-xl divide-y divide-border overflow-hidden">
              {contacts.map((c) => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed contact";
                return (
                  <div key={c.id} className="flex items-center gap-3 px-3 py-2.5 group">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                      {name.charAt(0).toUpperCase()}
                    </div>
                    <Link to={`/crm/${c.id}`} className="flex-1 min-w-0 hover:underline decoration-muted-foreground/50">
                      <p className="text-sm text-foreground truncate">{name}</p>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-2">
                        {c.email && (
                          <span className="inline-flex items-center gap-1 min-w-0 truncate">
                            <Mail className="w-3 h-3 shrink-0" /> {c.email}
                          </span>
                        )}
                        {c.phone && (
                          <span className="inline-flex items-center gap-1 shrink-0">
                            <Phone className="w-3 h-3" /> {c.phone}
                          </span>
                        )}
                        {!c.email && !c.phone && "No contact info"}
                      </p>
                    </Link>
                    <button
                      onClick={() => setLinked(c.id, false, name)}
                      disabled={link.isPending}
                      title="Unlink from this business"
                      aria-label={`Unlink ${name}`}
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                    >
                      {pendingContactId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* Invoices */}
        <Section title={`Invoices${invoices.length ? ` (${invoices.length})` : ""}`}>
          {invoicesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading invoices…
            </div>
          ) : invoices.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-3 bg-secondary/40 rounded-lg">
              <Receipt className="w-4 h-4 shrink-0" />
              No invoices for this business yet.
            </div>
          ) : (
            <div className="border border-border rounded-xl divide-y divide-border overflow-hidden">
              {invoices.map((inv) => (
                <Link
                  key={inv.id}
                  to={`/invoices?open=${inv.id}`}
                  className="flex items-center gap-3 px-3 py-2.5 hover:bg-secondary/40 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {inv.invoice_number ?? "Draft"}
                      {inv.title ? <span className="text-muted-foreground font-normal"> · {inv.title}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {inv.status === "draft" ? "Not sent" : `Due ${formatYmd(inv.due_date)}`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-foreground tabular-nums">{formatCents(inv.balance_due_cents, inv.currency)}</p>
                    <InvoiceStatusBadge status={inv.status} overdue={inv.overdue} className="mt-0.5" />
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </Section>

        {/* Statement */}
        <StatementSection orgId={orgId} accountId={account.id} billingEmail={account.billing_email} />
      </div>

      {editOpen && <AccountEditorDialog orgId={orgId} account={account} onClose={() => setEditOpen(false)} />}
      {pickerOpen && (
        <AccountContactPicker
          orgId={orgId}
          accountName={account.name}
          linkedIds={linkedIds}
          pendingId={pendingContactId}
          onPick={(c) => setLinked(c.id, true, c.name)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function StatementSection({ orgId, accountId, billingEmail }: { orgId: string; accountId: string; billingEmail: string | null }) {
  const { data: companies, isLoading } = useCompanies(orgId);
  const send = useSendStatement(orgId);
  const [pickedCompanyId, setPickedCompanyId] = useState<string>("");
  const [to, setTo] = useState("");

  const list = companies ?? [];
  const companyId = list.some((c) => c.id === pickedCompanyId) ? pickedCompanyId : (list[0]?.id ?? "");
  const override = to.trim();
  const overrideInvalid = override !== "" && !EMAIL_RE.test(override);
  const canEmail = Boolean(companyId) && !overrideInvalid && Boolean(override || billingEmail) && !send.isPending;

  const emailStatement = () => {
    if (!canEmail) return;
    send.mutate(
      { accountId, companyId, to: override || null },
      {
        onSuccess: (outcome) => {
          if (outcome.delivered) toast.success(`Statement emailed to ${outcome.to || override || billingEmail}`);
          else toast.error(`Statement not sent: ${outcome.reason ?? "unknown reason"}`);
        },
        onError: (err) => toast.error(errorMessage(err, "Couldn't send the statement.")),
      },
    );
  };

  return (
    <Section title="Statement">
      <p className="text-xs text-muted-foreground -mt-1">
        Every open invoice this business owes one of your companies, on one page.
      </p>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a company first.</p>
      ) : (
        <div className="space-y-3">
          {list.length > 1 && (
            <div>
              <label className={labelCls}>From company</label>
              <select value={companyId} onChange={(e) => setPickedCompanyId(e.target.value)} className={selectCls}>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls}>Send to</label>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={billingEmail ?? "No billing email — enter one"}
              className={cn(inputCls, overrideInvalid && "ring-1 ring-destructive")}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {billingEmail ? "Leave blank to use the billing email." : "Add a billing email to the account to skip this."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={companyId ? statementPdfUrl(orgId, accountId, companyId) : undefined}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
            >
              <FileText className="w-3.5 h-3.5" /> View statement PDF
            </a>
            <button
              onClick={emailStatement}
              disabled={!canEmail}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
            >
              {send.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              Email statement
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
