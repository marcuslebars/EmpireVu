import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sunrise } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Office manager (docs/ai-staff.md → "Office manager"): the morning
 * briefing — on/off, time, days and an email copy. Self-contained (own query + mutation), like
 * BookkeeperSettingsSection.
 */

export interface OfficeManagerSettings {
  enabled: boolean;
  enabledIsDefault: boolean;
  time: string;
  days: number[];
  channels: Array<"sms" | "email">;
  emailCopy: boolean;
}

export interface OfficeManagerView {
  companyId: string;
  companyName: string;
  settings: OfficeManagerSettings;
  defaultEnabled: boolean;
  ownerPhoneOnFile: boolean;
  ownerEmailOnFile: boolean;
  foldsMoneyAlert: boolean;
  lastBriefing: { date: string; status: string; sentAt: string | null; body: string | null } | null;
}

type Patch = { enabled?: boolean; time?: string; days?: number[]; emailCopy?: boolean };

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/office-manager`;

const TIMES = ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00"];
/** Monday first, Sunday last (0 = Sunday). */
const DAYS: Array<{ day: number; label: string }> = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

function timeText(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} a.m.`;
}

export function OfficeManagerSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["office-manager-settings", orgId, companyId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<OfficeManagerView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<OfficeManagerView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const title = "Office manager";
  const description = "A short text each morning: today's jobs, weather, money, what's waiting on you and how yesterday went.";
  const icon = <Sunrise className="w-4 h-4" />;

  if (isLoading) {
    return (
      <AiFrontDeskSectionCard icon={icon} title={title} description={description}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </AiFrontDeskSectionCard>
    );
  }
  if (error || !data) {
    return (
      <AiFrontDeskSectionCard icon={icon} title={title} description={description}>
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      </AiFrontDeskSectionCard>
    );
  }

  const s = data.settings;
  const locked = !canManage || update.isPending;
  const toggleDay = (day: number) => {
    const next = s.days.includes(day) ? s.days.filter((d) => d !== day) : [...s.days, day];
    if (next.length === 0) {
      toast.error("Pick at least one day.");
      return;
    }
    update.mutate({ days: next });
  };

  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title={title}
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={locked}
            onChange={(e) => update.mutate({ enabled: e.target.checked })}
            className="accent-primary w-4 h-4"
            aria-label="Morning briefing on"
          />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className="space-y-4">
        <fieldset className={cn("space-y-3", !s.enabled && "opacity-60")} disabled={locked || !s.enabled}>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-medium text-foreground" htmlFor={`om-time-${companyId}`}>
              Send at
            </label>
            <select
              id={`om-time-${companyId}`}
              value={s.time}
              onChange={(e) => update.mutate({ time: e.target.value })}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              {(TIMES.includes(s.time) ? TIMES : [...TIMES, s.time].sort()).map((t) => (
                <option key={t} value={t}>
                  {timeText(t)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
            {DAYS.map(({ day, label }) => {
              const on = s.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleDay(day)}
                  className={cn("h-8 min-w-[2.75rem] px-2 rounded-md border text-sm", on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground")}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <label className={cn("flex items-start gap-2.5 p-2.5 rounded-lg border border-border", locked || !s.enabled ? "cursor-default" : "cursor-pointer hover:bg-secondary/60")}>
            <input type="checkbox" className="accent-primary mt-0.5 w-4 h-4" checked={s.emailCopy} onChange={(e) => update.mutate({ emailCopy: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium text-foreground">Also email me a copy</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                With the full lists: every job by crew member, who's late paying and each approval waiting.
                {!data.ownerEmailOnFile && " No email on file for the owner yet."}
              </span>
            </span>
          </label>
        </fieldset>

        {data.foldsMoneyAlert && s.enabled && (
          <p className="text-xs text-muted-foreground">On briefing days the Bookkeeper's 8am money alert comes inside this text instead of a second one.</p>
        )}
        {data.lastBriefing?.body && (
          <div className="rounded-lg border border-border bg-secondary/40 p-2.5">
            <p className="text-xs font-medium text-foreground mb-1">Last briefing ({data.lastBriefing.date})</p>
            <p className="text-xs text-muted-foreground whitespace-pre-line">{data.lastBriefing.body}</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Text "today" to your assistant any time for the details.</p>
        {!data.ownerPhoneOnFile && s.enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to get the morning text.</p>}
        {!s.enabled && s.enabledIsDefault && !data.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn it on to get a morning text.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}
