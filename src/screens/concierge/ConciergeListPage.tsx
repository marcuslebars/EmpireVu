import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STAGE_LABELS, type ConciergeAccountSummary, type ConciergeStage } from "@/lib/concierge";
import { fetchConciergeAccounts } from "@/lib/concierge-api";
import { cn } from "@/lib/utils";
import { ConciergeShell, OperatorGate, PhoneLinks, ProgressDots, SlaBadge, TierBadge } from "@/screens/concierge/shared";

type Filter = "all" | ConciergeStage;
const FILTERS: Filter[] = ["needs_call", "setting_up", "live", "all"];

function matches(account: ConciergeAccountSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const digits = q.replace(/\D/g, "");
  return (
    account.businessName.toLowerCase().includes(needle) ||
    (account.owner.name ?? "").toLowerCase().includes(needle) ||
    (account.owner.email ?? "").toLowerCase().includes(needle) ||
    (digits.length >= 3 && (account.owner.phone ?? "").replace(/\D/g, "").includes(digits))
  );
}

function AccountRow({ account }: { account: ConciergeAccountSummary }) {
  const navigate = useNavigate();
  const href = `/concierge/${account.organizationId}`;
  const steps = account.checklist?.steps ?? [];
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(href);
      }}
      className={cn(
        "group grid cursor-pointer gap-x-4 gap-y-2 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40",
        "grid-cols-[1fr_auto] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_5.5rem_8rem_1rem] md:items-center",
      )}
    >
      {/* Business */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link to={href} className="truncate font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
            {account.businessName}
          </Link>
          <TierBadge tier={account.tier} />
        </div>
        {account.needsCall ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {account.needsCallReasons.map((r) => (
              <span key={r} className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                {r}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {account.isLive ? "Live" : account.checklist?.nextStepTitle ? `Next: ${account.checklist.nextStepTitle}` : STAGE_LABELS[account.stage]}
          </div>
        )}
      </div>

      {/* SLA — top-right on mobile */}
      <div className="justify-self-end md:order-3 md:justify-self-start">
        <SlaBadge account={account} />
      </div>

      {/* Owner */}
      <div className="col-span-2 min-w-0 md:order-2 md:col-span-1">
        <div className="truncate text-sm">{account.owner.name ?? "—"}</div>
        <div className="mt-1">
          <PhoneLinks phone={account.owner.phone} />
        </div>
      </div>

      {/* Progress */}
      <div className="col-span-2 flex items-center gap-2 md:order-4 md:col-span-1">
        <ProgressDots steps={steps} />
        {account.checklist && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {account.checklist.doneCount}/{account.checklist.totalCount}
          </span>
        )}
      </div>

      <ChevronRight className="hidden h-4 w-4 text-muted-foreground group-hover:text-foreground md:order-5 md:block" />
    </div>
  );
}

function ListBody() {
  const query = useQuery({ queryKey: ["concierge", "accounts"], queryFn: fetchConciergeAccounts, refetchInterval: 60_000 });
  const accounts = useMemo(() => query.data ?? [], [query.data]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: accounts.length, needs_call: 0, setting_up: 0, live: 0 };
    for (const a of accounts) c[a.stage] += 1;
    return c;
  }, [accounts]);
  const [chosen, setChosen] = useState<Filter | null>(null);
  const filter: Filter = chosen ?? (counts.needs_call > 0 ? "needs_call" : "all");
  const [q, setQ] = useState("");
  const visible = accounts.filter((a) => (filter === "all" || a.stage === filter) && matches(a, q.trim()));

  return (
    <ConciergeShell>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">CrankLeads setups</h1>
          <p className="text-sm text-muted-foreground">Newest first. Finish setup for anyone who isn't live.</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => query.refetch()} disabled={query.isFetching} aria-label="Refresh">
          <RefreshCw className={cn("h-3.5 w-3.5 sm:mr-1.5", query.isFetching && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 sm:pb-0">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setChosen(f)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                filter === f ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
              )}
            >
              {f === "all" ? "All" : STAGE_LABELS[f]}
              <span className={cn("tabular-nums text-xs", filter === f ? "opacity-80" : "text-muted-foreground")}>{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Business, owner, phone" className="h-9 pl-8" />
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_5.5rem_8rem_1rem] gap-x-4 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid">
          <span>Business</span>
          <span>Owner</span>
          <span>Since buy</span>
          <span>Progress</span>
          <span />
        </div>
        {query.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
          </div>
        ) : query.isError ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4" /> {(query.error as Error).message}
          </div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {accounts.length === 0 ? "No CrankLeads accounts yet." : "Nothing here."}
          </div>
        ) : (
          visible.map((a) => <AccountRow key={a.organizationId} account={a} />)
        )}
      </div>
    </ConciergeShell>
  );
}

export default function ConciergeListPage() {
  return (
    <OperatorGate>
      <ListBody />
    </OperatorGate>
  );
}
