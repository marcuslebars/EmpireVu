import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FileUp, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Customer import (docs/ai-staff.md → "Customer import"): on/off, a link
 * to the Import customers page, "text me the link", recent imports and balances on hold.
 * Self-contained (own query + mutations), like the other staff sections.
 */

interface BatchSummary {
  id: string;
  status: string;
  fileName: string;
  createdAt: string;
  counts: { contactsCreated: number; contactsMatched: number; jobsCreated: number; balancesCreated: number } | null;
}

export interface ImportOverview {
  companyId: string;
  companyName: string;
  settings: { enabled: boolean; enabledIsDefault: boolean };
  defaultEnabled: boolean;
  ownerPhoneOnFile: boolean;
  batches: BatchSummary[];
  held: { count: number; totalCents: number; pendingCode: number | null };
}

const settingsPath = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/import`;
const importsPath = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/imports`;

const STATUS: Record<string, string> = {
  uploading: "uploading",
  uploaded: "reading",
  mapped: "preview coming",
  previewed: "waiting for you to import",
  importing: "importing",
  done: "imported",
  failed: "didn't work",
  undoing: "undoing",
  undone: "undone",
};

function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-CA")}`;
}

export function ImporterSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["import-settings", orgId, companyId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<ImportOverview>(settingsPath(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: { enabled: boolean }) => apiFetch<ImportOverview>(settingsPath(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const sendLink = useMutation({
    mutationFn: () => apiFetch<{ sent: boolean }>(`${importsPath(orgId, companyId)}/send-link`, { method: "POST", body: "{}" }),
    onSuccess: () => toast.success("Link texted to your cell"),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't text the link"),
  });
  const startReminders = useMutation({
    mutationFn: () => apiFetch<{ code: number | null; created: boolean }>(`${importsPath(orgId, companyId)}/start-reminders`, { method: "POST", body: "{}" }),
    onSuccess: (r) => {
      toast.success(r.code ? `We texted you - reply Y ${r.code} to start reminders` : "Nothing on hold");
      void qc.invalidateQueries({ queryKey });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't ask"),
  });

  const description = "Bring your customer list over from your old app or a spreadsheet: customers, past jobs and balances owing. Nobody gets texted.";
  const icon = <FileUp className="w-4 h-4" />;

  if (isLoading) {
    return (
      <AiFrontDeskSectionCard icon={icon} title="Customer import" description={description}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </AiFrontDeskSectionCard>
    );
  }
  if (error || !data) {
    return (
      <AiFrontDeskSectionCard icon={icon} title="Customer import" description={description}>
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      </AiFrontDeskSectionCard>
    );
  }

  const s = data.settings;
  const locked = !canManage || update.isPending;
  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title="Customer import"
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input type="checkbox" checked={s.enabled} disabled={locked} onChange={(e) => update.mutate({ enabled: e.target.checked })} className="accent-primary w-4 h-4" aria-label="Customer import on" />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      {s.enabled ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Link to="/import" className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Import customers
            </Link>
            {canManage && data.ownerPhoneOnFile && (
              <button type="button" disabled={sendLink.isPending} onClick={() => sendLink.mutate()} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-60">
                Text me the link
              </button>
            )}
          </div>
          {data.held.count > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5 text-xs text-muted-foreground">
              <span>
                <span className="font-semibold text-foreground">{data.held.count}</span> imported balances ({dollars(data.held.totalCents)}) on hold - no reminders yet
                {data.held.pendingCode ? `. Reply Y ${data.held.pendingCode} to our text to start them.` : "."}
              </span>
              {canManage && !data.held.pendingCode && (
                <button type="button" disabled={startReminders.isPending} onClick={() => startReminders.mutate()} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary">
                  Start reminders…
                </button>
              )}
            </div>
          )}
          {data.batches.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {data.batches.slice(0, 3).map((b) => (
                <li key={b.id}>
                  <span className="text-foreground">{b.fileName}</span> · {STATUS[b.status] ?? b.status}
                  {b.counts ? ` · ${(b.counts.contactsCreated + b.counts.contactsMatched).toLocaleString("en-CA")} customers, ${b.counts.jobsCreated.toLocaleString("en-CA")} past jobs` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {s.enabledIsDefault && !data.defaultEnabled ? "Off for this business. Turn it on to bring a customer list over." : "Off - the import page and the texted link are turned off."}
        </p>
      )}
    </AiFrontDeskSectionCard>
  );
}
