import { useState } from "react";
import { Check, ClipboardCheck, X } from "lucide-react";

import { DashboardCard } from "@/components/ui/DashboardCard";
import { useApprovals, useDecideApproval, type ApprovalItem } from "@/lib/approvals-api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  executed: "Approved",
  approved: "Approved",
  rejected: "Skipped",
  expired: "Expired",
  failed: "Didn't go through",
  superseded: "Replaced",
};

const VIA_LABEL: Record<string, string> = { sms: "by text", app: "in the app", expiry: "", auto: "" };

function PendingRow({ item, orgId, showCompany }: { item: ApprovalItem; orgId: string; showCompany: boolean }) {
  const decide = useDecideApproval(orgId);
  const [note, setNote] = useState<string | null>(null);
  const busy = decide.isPending;

  const run = (decision: "approve" | "skip") =>
    decide.mutate(
      { id: item.id, decision },
      {
        onSuccess: (r) => setNote(r.message),
        onError: (e) => setNote(e instanceof Error ? e.message : "That didn't work — try again."),
      },
    );

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-foreground leading-snug">{item.summary}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {showCompany && item.companyName ? `${item.companyName} · ` : ""}
            {relativeTime(item.createdAt)}
            {item.shortCode != null ? ` · text "Y ${item.shortCode}" to approve` : ""}
          </p>
          {note && <p className="text-xs text-muted-foreground mt-1">{note}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => run("approve")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 active:scale-[0.97]"
          >
            <Check className="h-3.5 w-3.5" /> Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run("skip")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-3 disabled:opacity-50 active:scale-[0.97]"
          >
            <X className="h-3.5 w-3.5" /> Skip
          </button>
        </div>
      </div>
    </li>
  );
}

function RecentRow({ item, showCompany }: { item: ApprovalItem; showCompany: boolean }) {
  const label = STATUS_LABEL[item.status] ?? item.status;
  const via = item.decidedVia ? VIA_LABEL[item.decidedVia] ?? "" : "";
  return (
    <li className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-xs text-foreground/80 leading-snug truncate">{item.summary}</p>
        {item.resultMessage && <p className="text-[11px] text-muted-foreground truncate">{item.resultMessage}</p>}
      </div>
      <span
        className={cn(
          "shrink-0 text-[10px] font-medium",
          item.status === "failed" ? "text-destructive" : item.status === "executed" || item.status === "approved" ? "text-[hsl(var(--success))]" : "text-muted-foreground",
        )}
      >
        {label}
        {via ? ` ${via}` : ""}
        {showCompany && item.companyName ? ` · ${item.companyName}` : ""}
        {item.decidedAt ? ` · ${relativeTime(item.decidedAt)}` : ""}
      </span>
    </li>
  );
}

/**
 * What the AI front desk is waiting on the owner for ("Quote for Dana: $650 — Approve / Skip"),
 * plus the last week's decisions. Same decide path as replying Y/N by text. Hidden when empty.
 */
export function ApprovalsCard({ orgId, companyId }: { orgId: string; companyId?: string | null }) {
  const { data, isLoading, isError } = useApprovals(orgId, companyId);
  if (isLoading || isError || !data) return null;
  if (data.pending.length === 0 && data.recent.length === 0) return null;
  const companies = new Set([...data.pending, ...data.recent].map((a) => a.companyId));
  const showCompany = !companyId && companies.size > 1;

  return (
    <DashboardCard
      title="Approvals"
      icon={<ClipboardCheck className="w-3.5 h-3.5" />}
      badge={data.pending.length > 0 ? data.pending.length : undefined}
      variant={data.pending.length > 0 ? "elevated" : "default"}
      className="opacity-0 animate-fade-in"
    >
      {data.pending.length > 0 ? (
        <ul className="divide-y divide-border">
          {data.pending.map((item) => (
            <PendingRow key={item.id} item={item} orgId={orgId} showCompany={showCompany} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing waiting on you.</p>
      )}
      {data.recent.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Recent</p>
          <ul>
            {data.recent.slice(0, 5).map((item) => (
              <RecentRow key={item.id} item={item} showCompany={showCompany} />
            ))}
          </ul>
        </div>
      )}
    </DashboardCard>
  );
}
