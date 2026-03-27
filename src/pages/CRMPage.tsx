import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, List, Search, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { EmptyState, ErrorState, LoadingState } from "@/components/system/AsyncState";
import { useAppContext } from "@/lib/app-context";
import { apiRequest, toQueryString } from "@/lib/api";
import { formatCompactCurrency, formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";

interface CRMContactRow {
  bookingsCount: number;
  company: { id: string; name: string } | null;
  id: string;
  lastActivity: {
    eventType: string;
    occurredAt: string;
    title: string;
  } | null;
  name: string;
  nextAction: {
    detail: string;
    label: string;
    type: "urgent" | "action" | "wait" | "done";
  };
  owner: { name: string } | null;
  pipelineValueCents: number | null;
  realizedRevenueCents: number;
  stage: "lead" | "qualified" | "active" | "closed";
  upcomingBookingsCount: number;
}

interface CRMContactsResponse {
  pipelineSummary: Array<{
    count: number;
    stage: CRMContactRow["stage"];
    valueCents: number;
  }>;
  rows: {
    items: CRMContactRow[];
  };
}

const stageLabels: Record<CRMContactRow["stage"], string> = {
  active: "Active",
  closed: "Closed",
  lead: "Lead",
  qualified: "Qualified",
};

const actionStyles: Record<CRMContactRow["nextAction"]["type"], string> = {
  action: "bg-primary/10 text-primary",
  done: "bg-emerald-500/10 text-emerald-400",
  urgent: "bg-destructive/10 text-destructive",
  wait: "bg-amber-500/10 text-amber-400",
};

export default function CRMPage() {
  const navigate = useNavigate();
  const { activeCompanyId, activeOrganizationId } = useAppContext();
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<string>("all");
  const [view, setView] = useState<"table" | "pipeline">("table");

  const crmQuery = useQuery({
    queryKey: ["org", activeOrganizationId, "crm", activeCompanyId ?? "all", search, stage],
    queryFn: () =>
      apiRequest<CRMContactsResponse>(
        `/api/organizations/${activeOrganizationId}/ui/crm/contacts${toQueryString({
          companyId: activeCompanyId,
          limit: 100,
          page: 1,
          search,
          stage: stage === "all" ? undefined : stage,
        })}`,
      ),
  });

  if (crmQuery.isLoading) {
    return <LoadingState label="Loading CRM contacts..." />;
  }

  if (crmQuery.error) {
    return (
      <ErrorState
        description={crmQuery.error instanceof Error ? crmQuery.error.message : "Unable to load CRM contacts."}
        onRetry={() => crmQuery.refetch()}
        title="CRM unavailable"
      />
    );
  }

  const rows = crmQuery.data.rows.items;
  const pipelineSummary = crmQuery.data.pipelineSummary;
  const totalPipelineValue = pipelineSummary.reduce((sum, item) => sum + item.valueCents, 0);
  const grouped = pipelineSummary.map((summary) => ({
    contacts: rows.filter((row) => row.stage === summary.stage),
    summary,
  }));

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">CRM</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {rows.length} contacts · {formatCompactCurrency(totalPipelineValue)} total visible pipeline
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          <Users className="h-4 w-4 text-primary" />
          Live contact summaries update with org and company scope.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {pipelineSummary.map((item) => (
          <button
            key={item.stage}
            className={cn(
              "rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40",
              stage === item.stage && "border-primary/50 ring-1 ring-primary/20",
            )}
            onClick={() => setStage((current) => (current === item.stage ? "all" : item.stage))}
          >
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{stageLabels[item.stage]}</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{item.count}</p>
            <p className="text-sm text-muted-foreground">{formatCompactCurrency(item.valueCents)}</p>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground outline-none ring-0"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search contacts..."
            value={search}
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
          <button
            className={cn("rounded-md p-2", view === "table" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
            onClick={() => setView("table")}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            className={cn("rounded-md p-2", view === "pipeline" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
            onClick={() => setView("pipeline")}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          description="This organization has no contacts for the current scope yet. Create a contact or widen the company filter."
          title="No CRM contacts found"
        />
      ) : null}

      {rows.length > 0 && view === "table" ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Next Action</th>
                <th className="px-4 py-3">Bookings</th>
                <th className="px-4 py-3">Revenue</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Last Activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer border-b border-border/40 transition-colors hover:bg-secondary/20"
                  onClick={() => navigate(`/crm/${row.id}`)}
                >
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-foreground">{row.name}</p>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{row.company?.name ?? "No company"}</td>
                  <td className="px-4 py-3 text-sm text-foreground">{stageLabels[row.stage]}</td>
                  <td className="px-4 py-3">
                    <span className={cn("rounded-md px-2 py-1 text-xs font-medium", actionStyles[row.nextAction.type])}>
                      {row.nextAction.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {row.bookingsCount}
                    {row.upcomingBookingsCount > 0 ? ` · ${row.upcomingBookingsCount} upcoming` : ""}
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">{formatCompactCurrency(row.realizedRevenueCents)}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{row.owner?.name ?? "Unassigned"}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {row.lastActivity ? `${row.lastActivity.title} · ${formatRelativeTime(row.lastActivity.occurredAt)}` : "No activity yet"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows.length > 0 && view === "pipeline" ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
          {grouped.map(({ contacts, summary }) => (
            <div key={summary.stage} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">{stageLabels[summary.stage]}</p>
                <p className="text-sm text-muted-foreground">{contacts.length} visible contacts</p>
              </div>
              {contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No contacts in this stage.</p>
              ) : null}
              <div className="space-y-3">
                {contacts.map((contact) => (
                  <button
                    key={contact.id}
                    className="w-full rounded-lg border border-border/60 bg-background/30 p-3 text-left transition-colors hover:border-primary/40"
                    onClick={() => navigate(`/crm/${contact.id}`)}
                  >
                    <p className="text-sm font-medium text-foreground">{contact.name}</p>
                    <p className="text-xs text-muted-foreground">{contact.company?.name ?? "No company"}</p>
                    <p className="mt-2 text-xs text-primary">{contact.nextAction.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{contact.nextAction.detail}</p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}