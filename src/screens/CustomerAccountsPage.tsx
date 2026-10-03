import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Building2, ChevronRight, Plus, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useOrgId } from "@/lib/org-context";
import { useCustomerAccounts } from "@/lib/invoice-hooks";
import { formatCents, type CustomerAccount } from "@/lib/invoices-api";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorBanner, SkeletonRow } from "@/components/ui/StateViews";
import { AccountEditorDialog } from "@/components/invoices/AccountEditorDialog";
import { AccountDetailSheet } from "@/components/invoices/AccountDetailSheet";
import { accountTermsLabel } from "@/components/invoices/AccountTerms";

const thCls = "px-4 py-3 text-[10px] font-bold text-muted-foreground uppercase tracking-wider";

function OverdueCell({ count }: { count: number }) {
  if (count <= 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-destructive/10 text-destructive border border-destructive/20 whitespace-nowrap">
      {count} overdue
    </span>
  );
}

function ArchivedPill() {
  return (
    <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground shrink-0">
      Archived
    </span>
  );
}

export default function CustomerAccountsPage() {
  const orgId = useOrgId();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, refetch } = useCustomerAccounts(orgId, {
    q: debounced || undefined,
    archived: showArchived || undefined,
  });
  const accounts = data ?? [];

  // Deep links: ?open={accountId} opens the detail sheet, ?new=1 the create dialog.
  const openId = searchParams.get("open");
  const creating = searchParams.get("new") === "1";

  const setParam = (key: string, value: string | null, extra?: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    extra?.(next);
    setSearchParams(next, { replace: value === null });
  };

  const openAccount = (id: string) => setParam("open", id);
  const closeAccount = () => setParam("open", null);
  const startCreate = () => setParam("new", "1");
  const closeCreate = () => setParam("new", null);
  const afterCreate = (account: CustomerAccount) =>
    setParam("open", account.id, (p) => {
      p.delete("new");
    });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Business accounts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Marinas, clubs and other businesses you invoice</p>
        </div>
        <button
          onClick={startCreate}
          className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-md shadow-primary/20 active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" />
          New business account
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search businesses..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-card border border-border rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Show archived" />
          Show archived
        </label>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          <SkeletonRow cols={6} />
          <SkeletonRow cols={6} />
          <SkeletonRow cols={6} />
        </div>
      ) : isError ? (
        <ErrorBanner message="Failed to load business accounts." onRetry={() => refetch()} />
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={debounced ? "No businesses match" : "No business accounts yet"}
          description={
            debounced
              ? "Try a different name."
              : "Add the marinas, clubs and fleets you bill. Link their people as contacts and every invoice goes to the business."
          }
          action={!debounced ? { label: "New business account", onClick: startCreate } : undefined}
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-card border border-border rounded-xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left border-collapse">
                <thead>
                  <tr className="bg-secondary/30 border-b border-border">
                    <th className={thCls}>Name</th>
                    <th className={thCls}>Billing email</th>
                    <th className={cn(thCls, "text-right")}>Contacts</th>
                    <th className={cn(thCls, "text-right")}>Open balance</th>
                    <th className={thCls}>Overdue</th>
                    <th className={thCls}>Terms</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {accounts.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => openAccount(a.id)}
                      className={cn("hover:bg-secondary/40 transition-colors cursor-pointer group", a.archived_at && "opacity-60")}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                            <Building2 className="w-4 h-4 text-primary" />
                          </div>
                          <span className="text-sm font-semibold text-foreground truncate">{a.name}</span>
                          {a.archived_at && <ArchivedPill />}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground/80">
                        {a.billing_email ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-foreground tabular-nums text-right">{a.contact_count ?? 0}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-foreground tabular-nums text-right">
                        {formatCents(a.open_balance_cents ?? 0)}
                      </td>
                      <td className="px-4 py-3">
                        <OverdueCell count={a.overdue_count ?? 0} />
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground/80 whitespace-nowrap">{accountTermsLabel(a.payment_terms_days)}</td>
                      <td className="px-4 py-3 text-right">
                        <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity inline-block" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => openAccount(a.id)}
                className={cn(
                  "w-full text-left bg-card border border-border rounded-xl p-4 shadow-sm hover:border-primary/30 transition-all",
                  a.archived_at && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-foreground truncate">{a.name}</p>
                      {a.archived_at && <ArchivedPill />}
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{a.billing_email ?? "No billing email"}</p>
                  </div>
                  <p className="text-sm font-semibold text-foreground tabular-nums shrink-0">{formatCents(a.open_balance_cents ?? 0)}</p>
                </div>
                <div className="flex items-center gap-3 mt-3 text-[11px] text-muted-foreground">
                  <span>
                    {a.contact_count ?? 0} contact{a.contact_count === 1 ? "" : "s"}
                  </span>
                  <span>·</span>
                  <span>{accountTermsLabel(a.payment_terms_days)}</span>
                  {(a.overdue_count ?? 0) > 0 && (
                    <span className="ml-auto">
                      <OverdueCell count={a.overdue_count ?? 0} />
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <AccountDetailSheet orgId={orgId} accountId={openId} onClose={closeAccount} />
      {creating && <AccountEditorDialog orgId={orgId} onClose={closeCreate} onSaved={afterCreate} />}
    </div>
  );
}
