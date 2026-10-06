import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, BookOpenCheck, CheckCircle2, Clock, Link2Off, Loader2, RefreshCw, XCircle } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { useCompanies } from "@/lib/api-hooks";
import {
  EXPENSE_CATEGORY_KEYS,
  useAccountingOptions,
  useAccountingStatus,
  useConnectAccounting,
  useDisconnectAccounting,
  useSaveAccountingSettings,
  useSyncNow,
  type AccountingJob,
  type AccountingSettings as Settings,
  type AccountingStatus,
  type ProviderId,
  type ProviderOptions,
  type Ref,
} from "@/lib/accounting-api";
import { categoryLabel } from "@/lib/expenses-api";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";

const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const hintCls = "text-xs text-muted-foreground mt-1";
const selectCls =
  "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60";
const btn = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-sm font-medium border transition-colors disabled:opacity-60";

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function RefSelect({
  id,
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
  emptyLabel = "Choose…",
}: {
  id: string;
  label: string;
  hint?: string;
  value: Ref | null | undefined;
  options: Ref[];
  onChange: (r: Ref | null) => void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const list = value && !options.some((o) => o.id === value.id) ? [value, ...options] : options;
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <select id={id} value={value?.id ?? ""} disabled={disabled} onChange={(e) => onChange(list.find((o) => o.id === e.target.value) ?? null)} className={selectCls}>
        <option value="">{emptyLabel}</option>
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {hint && <p className={hintCls}>{hint}</p>}
    </div>
  );
}

function ProviderMark({ id }: { id: ProviderId }) {
  return (
    <div
      className={cn(
        "w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold shrink-0",
        id === "quickbooks" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-sky-500/15 text-sky-600 dark:text-sky-400",
      )}
      aria-hidden
    >
      {id === "quickbooks" ? "qb" : "x"}
    </div>
  );
}

function ConnectChoices({ orgId, companyId, status }: { orgId: string; companyId: string; status: AccountingStatus }) {
  const connect = useConnectAccounting(orgId, companyId);
  const go = (p: ProviderId) =>
    connect.mutate(p, { onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't start connecting.") });
  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        {status.providers.map((p) => (
          <div key={p.id} className="rounded-xl border border-border p-4 flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <ProviderMark id={p.id} />
              <div>
                <p className="text-sm font-semibold text-foreground">{p.label}</p>
                <p className="text-xs text-muted-foreground">{p.id === "quickbooks" ? "QuickBooks Online (not Desktop)" : "Any Xero organisation"}</p>
              </div>
            </div>
            <button
              type="button"
              disabled={!p.configured || connect.isPending}
              onClick={() => go(p.id)}
              className={cn(btn, "bg-primary text-primary-foreground border-primary hover:bg-primary/90")}
            >
              {connect.isPending && connect.variables === p.id && <Loader2 className="w-4 h-4 animate-spin" />}
              Connect {p.label}
            </button>
            {!p.configured && <p className="text-[11px] text-muted-foreground">Not set up on this server yet — ask EmpireVu support to turn it on.</p>}
          </div>
        ))}
      </div>
      <div className="rounded-lg bg-secondary/50 px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p className="text-foreground font-medium text-sm">What syncs</p>
        <p>Sent invoices (with their customer), payments, refunds and voids, and expenses with their receipt photos — one way, from EmpireVu into your books.</p>
        <p>You choose a start date, so nothing you've already entered by hand is duplicated. Drafts never sync.</p>
      </div>
    </div>
  );
}

function blankFrom(settings: Settings, suggested: Partial<Settings> | undefined): Settings {
  if (!suggested) return settings;
  const pick = <K extends keyof Settings>(k: K): Settings[K] => (settings[k] ?? suggested[k] ?? null) as Settings[K];
  return {
    ...settings,
    incomeTarget: pick("incomeTarget"),
    salesTaxCode: pick("salesTaxCode"),
    salesExemptCode: pick("salesExemptCode"),
    paymentAccount: pick("paymentAccount"),
    expenseFallbackAccount: pick("expenseFallbackAccount"),
    purchaseTaxCode: pick("purchaseTaxCode"),
    purchaseExemptCode: pick("purchaseExemptCode"),
    paidFromBusiness: pick("paidFromBusiness"),
    expenseAccounts: { ...(suggested.expenseAccounts ?? {}), ...settings.expenseAccounts },
  };
}

function Mapping({ orgId, companyId, status, options, suggested }: { orgId: string; companyId: string; status: AccountingStatus; options: ProviderOptions; suggested: Partial<Settings> }) {
  const conn = status.connection!;
  const qbo = conn.provider === "quickbooks";
  const us = qbo && conn.settings.country === "US";
  const save = useSaveAccountingSettings(orgId, companyId);
  const [form, setForm] = useState<Settings>(() => blankFrom(conn.settings, suggested));
  const [start, setStart] = useState(conn.syncStartDate);
  const [showCategories, setShowCategories] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));
  const firstSetup = conn.missing.invoices.length > 0 || conn.missing.expenses.length > 0;

  const onSave = async () => {
    try {
      const { country: _c, currency: _cur, ...settings } = form;
      const res = await save.mutateAsync({ settings, syncStartDate: start });
      const left = [...res.connection!.missing.invoices, ...res.connection!.missing.expenses];
      if (left.length) toast.message(`Saved. Still to choose: ${left.join(", ")}.`);
      else toast.success(res.counts.pending ? `Saved — syncing ${res.counts.pending} record${res.counts.pending === 1 ? "" : "s"} now.` : "Saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Invoices &amp; payments</p>
            <p className="text-xs text-muted-foreground">Sent invoices, their customers, payments, refunds and voids.</p>
          </div>
          <Switch checked={form.syncInvoices} onCheckedChange={(v) => set("syncInvoices", v)} aria-label="Sync invoices and payments" />
        </div>
        {form.syncInvoices && (
          <div className="grid sm:grid-cols-2 gap-4">
            <RefSelect
              id="acc-income"
              label={qbo ? "Product/service for invoice lines" : "Sales account"}
              hint={qbo ? "Each line is booked to this product/service (and its income account)." : "Invoice lines are coded to this account."}
              value={form.incomeTarget}
              options={options.incomeTargets}
              onChange={(r) => set("incomeTarget", r)}
            />
            <RefSelect
              id="acc-deposit"
              label={qbo ? "Payments go to" : "Bank account for payments"}
              hint={qbo ? "Undeposited Funds lets you group them into bank deposits." : "Must be a bank account in Xero."}
              value={form.paymentAccount}
              options={options.depositAccounts}
              onChange={(r) => set("paymentAccount", r)}
            />
            {!us && (
              <>
                <RefSelect id="acc-salestax" label="Tax code for taxed lines" hint="e.g. HST ON" value={form.salesTaxCode} options={options.salesTaxCodes} onChange={(r) => set("salesTaxCode", r)} />
                <RefSelect
                  id="acc-salesexempt"
                  label="Tax code for untaxed lines"
                  hint="Used for 0% invoices and deposit lines."
                  value={form.salesExemptCode}
                  options={options.salesTaxCodes}
                  onChange={(r) => set("salesExemptCode", r)}
                />
              </>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Expenses</p>
            <p className="text-xs text-muted-foreground">Each expense with its receipt attached, coded by category.</p>
          </div>
          <Switch checked={form.syncExpenses} onCheckedChange={(v) => set("syncExpenses", v)} aria-label="Sync expenses" />
        </div>
        {form.syncExpenses && (
          <>
            <div className="grid sm:grid-cols-2 gap-4">
              <RefSelect
                id="acc-paidfrom"
                label="Business expenses are paid from"
                hint="Your business bank or credit card."
                value={form.paidFromBusiness}
                options={options.paidFromAccounts}
                onChange={(r) => set("paidFromBusiness", r)}
              />
              <RefSelect
                id="acc-paidpersonal"
                label="Out-of-pocket expenses are booked from"
                hint="Optional — e.g. a 'due to owner' account. Blank uses the one above."
                value={form.paidFromPersonal}
                options={options.paidFromAccounts}
                onChange={(r) => set("paidFromPersonal", r)}
                emptyLabel="Same as business"
              />
              <RefSelect
                id="acc-fallback"
                label="Default expense account"
                hint="For any category you don't map below."
                value={form.expenseFallbackAccount}
                options={options.expenseAccounts}
                onChange={(r) => set("expenseFallbackAccount", r)}
              />
              {!us && (
                <>
                  <RefSelect id="acc-purchtax" label="Tax code when tax was paid" hint="So you can claim it back." value={form.purchaseTaxCode} options={options.purchaseTaxCodes} onChange={(r) => set("purchaseTaxCode", r)} />
                  <RefSelect id="acc-purchexempt" label="Tax code when no tax was paid" value={form.purchaseExemptCode} options={options.purchaseTaxCodes} onChange={(r) => set("purchaseExemptCode", r)} />
                </>
              )}
            </div>
            <button type="button" onClick={() => setShowCategories((v) => !v)} className="text-xs font-medium text-primary hover:underline">
              {showCategories ? "Hide" : "Choose"} accounts by category ({Object.keys(form.expenseAccounts).length} of {EXPENSE_CATEGORY_KEYS.length} set)
            </button>
            {showCategories && (
              <div className="grid sm:grid-cols-2 gap-3">
                {EXPENSE_CATEGORY_KEYS.map((k) => (
                  <RefSelect
                    key={k}
                    id={`acc-cat-${k}`}
                    label={categoryLabel(k)}
                    value={form.expenseAccounts[k] ?? null}
                    options={options.expenseAccounts}
                    emptyLabel="Default expense account"
                    onChange={(r) =>
                      setForm((f) => {
                        const next = { ...f.expenseAccounts };
                        if (r) next[k] = r;
                        else delete next[k];
                        return { ...f, expenseAccounts: next };
                      })
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-4 items-end">
        <div>
          <label htmlFor="acc-start" className={labelCls}>
            Sync records from
          </label>
          <input id="acc-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className={selectCls} />
          <p className={hintCls}>Invoices issued and expenses dated before this stay out of your books (avoids duplicates).</p>
        </div>
        <div className="flex sm:justify-end">
          <button type="button" onClick={() => void onSave()} disabled={save.isPending} className={cn(btn, "bg-primary text-primary-foreground border-primary hover:bg-primary/90 h-10 px-4")}>
            {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {firstSetup ? "Save & start syncing" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_ICON: Record<AccountingJob["status"], JSX.Element> = {
  done: <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-label="Synced" />,
  skipped: <CheckCircle2 className="w-4 h-4 text-muted-foreground" aria-label="Skipped" />,
  pending: <Clock className="w-4 h-4 text-amber-600" aria-label="Waiting" />,
  running: <Loader2 className="w-4 h-4 animate-spin text-primary" aria-label="Syncing" />,
  failed: <XCircle className="w-4 h-4 text-destructive" aria-label="Failed" />,
};

function Activity({ status }: { status: AccountingStatus }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const rows = onlyProblems ? status.recent.filter((r) => r.status === "failed" || (r.status === "pending" && r.lastError)) : status.recent;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">Activity</p>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{status.counts.synced}</span> in your books
          </span>
          <span>
            <span className="font-semibold text-foreground">{status.counts.pending}</span> waiting
          </span>
          <button type="button" onClick={() => setOnlyProblems((v) => !v)} className={cn("hover:underline", status.counts.failed ? "text-destructive font-semibold" : "")}>
            {status.counts.failed} failed{onlyProblems ? " · show all" : ""}
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground bg-secondary/50 rounded-lg px-3 py-3">
          {onlyProblems ? "No problems." : "Nothing synced yet. Send an invoice or log an expense and it will appear here within a minute."}
        </p>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border">
          {rows.slice(0, 25).map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5 shrink-0">{STATUS_ICON[r.status]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground truncate">{r.label}</p>
                <p className={cn("text-xs", r.status === "failed" || r.lastError ? "text-destructive" : "text-muted-foreground")}>
                  {r.status === "failed" || (r.status === "pending" && r.lastError) ? r.lastError : (r.detail ?? (r.status === "pending" ? "Waiting to sync" : ""))}
                  {r.status === "pending" && r.lastError ? " — retrying automatically" : ""}
                </p>
              </div>
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">{when(r.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Connected({ orgId, companyId, status }: { orgId: string; companyId: string; status: AccountingStatus }) {
  const conn = status.connection!;
  const connect = useConnectAccounting(orgId, companyId);
  const disconnect = useDisconnectAccounting(orgId, companyId);
  const syncNow = useSyncNow(orgId, companyId);
  const reauth = conn.status === "needs_reauth";
  const { data: opts, error: optsError, isLoading: optsLoading } = useAccountingOptions(orgId, companyId, !reauth);
  const [confirming, setConfirming] = useState(false);
  const missing = [...conn.missing.invoices, ...conn.missing.expenses];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderMark id={conn.provider} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">
              {conn.providerLabel}
              {conn.remoteName ? ` · ${conn.remoteName}` : ""}
              {conn.environment === "sandbox" && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-amber-600">Sandbox</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              Connected {new Date(conn.connectedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })} · last sync {when(conn.lastSyncAt)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={reauth || syncNow.isPending || missing.length > 0}
            onClick={() =>
              syncNow.mutate(undefined, {
                onSuccess: (r) => toast.success(r.queued ? `Queued ${r.queued} record${r.queued === 1 ? "" : "s"} — syncing now.` : "Syncing now."),
                onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't start a sync."),
              })
            }
            className={cn(btn, "bg-secondary border-border text-foreground hover:bg-secondary/80")}
          >
            {syncNow.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Sync now
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                disabled={disconnect.isPending}
                onClick={() =>
                  disconnect.mutate(undefined, {
                    onSuccess: () => toast.success(`Disconnected from ${conn.providerLabel}.`),
                    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't disconnect."),
                  })
                }
                className={cn(btn, "bg-destructive/10 border-destructive/30 text-destructive")}
              >
                {disconnect.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Yes, disconnect
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={cn(btn, "bg-secondary border-border text-foreground")}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className={cn(btn, "bg-secondary border-border text-muted-foreground hover:text-foreground")}>
              <Link2Off className="w-4 h-4" /> Disconnect
            </button>
          )}
        </div>
      </div>
      {confirming && <p className="text-xs text-muted-foreground -mt-4">Syncing stops. Everything already in {conn.providerLabel} stays there.</p>}

      {reauth && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-foreground flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <span>
              The sign-in to {conn.providerLabel} expired, so syncing is paused. Reconnect the same file and it picks up where it left off.
              {conn.lastError && <span className="block text-xs text-muted-foreground mt-1">{conn.lastError}</span>}
            </span>
          </p>
          <button type="button" onClick={() => connect.mutate(conn.provider)} disabled={connect.isPending} className={cn(btn, "bg-primary text-primary-foreground border-primary")}>
            {connect.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Reconnect
          </button>
        </div>
      )}

      {!reauth && missing.length > 0 && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm text-foreground">
          <p className="font-semibold">One more step: choose where things go in {conn.providerLabel}.</p>
          <p className="text-xs text-muted-foreground mt-1">We've pre-filled our best guesses from your chart of accounts — check them, then save. Nothing syncs until you do.</p>
        </div>
      )}

      {!reauth &&
        (optsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading your accounts from {conn.providerLabel}…
          </div>
        ) : optsError || !opts ? (
          <p className="text-sm text-destructive">{optsError instanceof Error ? optsError.message : `Couldn't read your accounts from ${conn.providerLabel}.`}</p>
        ) : (
          <Mapping orgId={orgId} companyId={companyId} status={status} options={opts.options} suggested={opts.suggested} />
        ))}

      <Activity status={status} />
    </div>
  );
}

function Panel({ orgId, companyId }: { orgId: string; companyId: string }) {
  const { data: status, isLoading, error } = useAccountingStatus(orgId, companyId);
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (error || !status) return <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Couldn't load the accounting settings."}</p>;
  return status.connection ? <Connected key={status.connection.connectedAt} orgId={orgId} companyId={companyId} status={status} /> : <ConnectChoices orgId={orgId} companyId={companyId} status={status} />;
}

export function AccountingSettings() {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);
  const [params, setParams] = useSearchParams();
  const [picked, setPicked] = useState<string | null>(() => params.get("company"));
  const list = useMemo(() => companies ?? [], [companies]);
  const companyId = picked && list.some((c) => c.id === picked) ? picked : (list[0]?.id ?? null);

  // Back from QuickBooks / Xero.
  useEffect(() => {
    const ok = params.get("accounting");
    const err = params.get("accounting_error");
    if (!ok && !err) return;
    if (ok === "connected") toast.success("Connected — now choose where things go.");
    if (err) toast.error(err);
    const next = new URLSearchParams(params);
    next.delete("accounting");
    next.delete("accounting_error");
    next.delete("company");
    setParams(next, { replace: true });
  }, [params, setParams]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <BookOpenCheck className="w-4 h-4 text-muted-foreground" /> Accounting
        </h2>
        <p className="text-sm text-muted-foreground mt-1">Send invoices, payments and expenses to QuickBooks Online or Xero automatically.</p>
      </div>
      {!canManage ? (
        <p className="text-sm text-muted-foreground bg-secondary rounded-lg px-3 py-2.5">Only owners and admins can manage the accounting connection.</p>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">No companies yet. Add a company under the Organization tab first.</div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1 bg-secondary/50 rounded-lg p-1 border border-border w-fit max-w-full">
                {list.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setPicked(c.id)}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-xs font-medium transition-all truncate max-w-[200px]",
                      c.id === companyId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              <p className={hintCls}>Each company connects its own books.</p>
            </div>
          )}
          {companyId && <Panel key={companyId} orgId={organizationId} companyId={companyId} />}
        </>
      )}
    </div>
  );
}
