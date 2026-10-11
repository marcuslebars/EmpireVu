import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-client";
import { toast } from "@/components/ui/sonner";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Estimator (docs/ai-staff.md "## Estimator"): prices jobs the price
 * list can't (photos + description → an estimate you OK by text → a quote), and texts quotes
 * until they're booked. Self-contained (own query + mutation).
 */

export interface EstimatorSettingsView {
  companyId: string;
  enabled: boolean;
  followUps: boolean;
  cadenceDays: number[];
  enabledIsDefault: boolean;
  defaultEnabled: boolean;
  stats: { waitingOnYou: number; sent30d: number; followingUp: number };
}

type Patch = Partial<Pick<EstimatorSettingsView, "enabled" | "followUps" | "cadenceDays">>;

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/estimator`;

const CADENCES: Array<{ days: number[]; label: string }> = [
  { days: [2, 5, 10], label: "2, 5 and 10 days after (recommended)" },
  { days: [1, 3, 7], label: "1, 3 and 7 days after" },
  { days: [3, 7, 14], label: "3, 7 and 14 days after" },
  { days: [3, 10], label: "3 and 10 days after" },
];

const key = (days: number[]) => days.join(",");

export function EstimatorSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["estimator-settings", orgId, companyId];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => apiFetch<EstimatorSettingsView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<EstimatorSettingsView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const cadenceOptions = data && !CADENCES.some((c) => key(c.days) === key(data.cadenceDays))
    ? [...CADENCES, { days: data.cadenceDays, label: `${data.cadenceDays.join(", ")} days after` }]
    : CADENCES;

  return (
    <AiFrontDeskSectionCard
      icon={<Calculator className="w-4 h-4" />}
      title="Estimator"
      description="Prices jobs your price list can't. The customer sends photos and a description, the AI drafts an estimate, and nothing goes out until you reply Y."
      aside={
        data ? (
          <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={!canManage || update.isPending}
              onChange={(e) => update.mutate({ enabled: e.target.checked })}
              className="accent-primary w-4 h-4"
              aria-label="Estimator on"
            />
            <span className="text-sm font-medium text-foreground">{data.enabled ? "On" : "Off"}</span>
          </label>
        ) : null
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{data.stats.waitingOnYou}</span> estimates waiting for your OK
            </span>
            <span>
              <span className="font-semibold text-foreground">{data.stats.sent30d}</span> sent as quotes in the last 30 days
            </span>
            <span>
              <span className="font-semibold text-foreground">{data.stats.followingUp}</span> quotes being followed up
            </span>
          </div>

          <div className="rounded-lg bg-secondary/50 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">How you approve one</p>
            <p>You get a text with each line, the total + HST, how sure the AI is and what it assumed. Reply <span className="font-mono">Y 12</span> to send the quote, <span className="font-mono">Y 12 $900</span> to send it at your price instead, or <span className="font-mono">N 12</span> and the customer hears you'll be in touch.</p>
          </div>

          <fieldset className={cn("space-y-3", !data.enabled && "opacity-60")} disabled={!canManage || !data.enabled || update.isPending}>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={data.followUps}
                onChange={(e) => update.mutate({ followUps: e.target.checked })}
                className="accent-primary mt-0.5 w-4 h-4"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">Follow up quotes until they're booked</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  A short text from your number with the quote link. The last one offers a call or your booking link. Stops as soon as they book, reply, opt out, or you take over the conversation. Only 9 am to 8 pm.
                </span>
              </span>
            </label>
            <label className={cn("block space-y-1 pl-6", !data.followUps && "opacity-60")}>
              <span className="block text-xs font-medium text-foreground">When to text</span>
              <select
                value={key(data.cadenceDays)}
                disabled={!data.followUps}
                onChange={(e) => update.mutate({ cadenceDays: e.target.value.split(",").map(Number) })}
                className="w-full sm:w-auto rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              >
                {cadenceOptions.map((option) => (
                  <option key={key(option.days)} value={key(option.days)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
          {data.enabledIsDefault && !data.defaultEnabled && (
            <p className="text-xs text-muted-foreground">Off unless you switch it on.</p>
          )}
        </div>
      )}
    </AiFrontDeskSectionCard>
  );
}
