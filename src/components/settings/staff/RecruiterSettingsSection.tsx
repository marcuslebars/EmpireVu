import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Lock, Unlock, UserPlus } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiAuthHeaders, apiFetch, resolveApiUrl } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Hiring & payroll (docs/ai-staff.md → "Hiring & payroll"): pay
 * period, where the payroll CSV goes, recent pay periods (download / lock / unlock) and the job
 * posts with their applicants. Self-contained (own query + mutations).
 */

type Frequency = "weekly" | "biweekly" | "semimonthly";

export interface RecruiterSettings {
  payroll: { enabled: boolean; frequency: Frequency; anchorDate: string; csvEmail: string | null };
  hiring: { enabled: boolean };
  defaultEnabled: boolean;
}

export interface RecruiterPeriodView {
  id: string;
  start: string;
  end: string;
  status: string;
  people: number;
  totalMinutes: number;
  otMinutes: number;
  openEntries: number;
  lockedAt: string | null;
  lockedWithOpenEntries: boolean;
  unlockedAt: string | null;
  csvEmailedTo: string | null;
  csvEmailedAt: string | null;
  csvEmailError: string | null;
}

export interface RecruiterJobView {
  id: string;
  title: string;
  status: string;
  url: string | null;
  applicants: number;
  newApplicants: number;
  createdAt: string;
}

export interface RecruiterView {
  companyId: string;
  companyName: string;
  settings: RecruiterSettings;
  defaultEnabled: boolean;
  ownerPhoneOnFile: boolean;
  fallbackEmail: string | null;
  siteLive: boolean;
  currentPeriod: { start: string; end: string };
  nextAskOn: string;
  periods: RecruiterPeriodView[] | null;
  jobs: RecruiterJobView[] | null;
}

interface Patch {
  payroll?: { enabled?: boolean; frequency?: Frequency; anchorDate?: string; csvEmail?: string | null };
  hiring?: { enabled?: boolean };
}

const base = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}`;

const FREQUENCIES: Array<{ value: Frequency; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "semimonthly", label: "Twice a month (1st-15th, 16th-end)" },
];

const STATUS_LABEL: Record<string, string> = {
  pending: "Checking",
  awaiting_owner: "Waiting on your OK",
  locked: "Locked",
  unlocked: "Unlocked",
  skipped: "Not locked",
  expired: "Not locked",
  empty: "No hours",
};

function day(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric" });
}

function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

async function downloadCsv(orgId: string, companyId: string, period: RecruiterPeriodView): Promise<void> {
  const res = await fetch(resolveApiUrl(`${base(orgId, companyId)}/payroll/periods/${period.id}/csv`), { headers: await apiAuthHeaders() });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `payroll-${period.start}-to-${period.end}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={cn("flex items-center gap-2", disabled ? "cursor-default" : "cursor-pointer")}>
      <input type="checkbox" className="accent-primary w-4 h-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="text-sm font-medium text-foreground">{label}</span>
    </label>
  );
}

export function RecruiterSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["recruiter-settings", orgId, companyId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<RecruiterView>(`${base(orgId, companyId)}/ai-settings/recruiter`),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<RecruiterView>(`${base(orgId, companyId)}/ai-settings/recruiter`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const periodAction = useMutation({
    mutationFn: (input: { periodId: string; action: "lock" | "unlock" }) =>
      apiFetch<RecruiterView>(`${base(orgId, companyId)}/payroll/periods/${input.periodId}`, { method: "POST", body: JSON.stringify({ action: input.action }) }),
    onSuccess: (view, input) => {
      qc.setQueryData(queryKey, view);
      toast.success(input.action === "lock" ? "Locked" : "Unlocked - those hours can be edited again");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not do that"),
  });
  const [anchor, setAnchor] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    if (data) {
      setAnchor(data.settings.payroll.anchorDate);
      setEmail(data.settings.payroll.csvEmail ?? "");
    }
  }, [data]);

  const description = "Payroll hours with Ontario overtime flags, locked and emailed when you OK them, and hiring: job posts, an apply page, applicants sorted for you.";
  const icon = <UserPlus className="w-4 h-4" />;

  if (isLoading) {
    return (
      <AiFrontDeskSectionCard icon={icon} title="Hiring & payroll" description={description}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </AiFrontDeskSectionCard>
    );
  }
  if (error || !data) {
    return (
      <AiFrontDeskSectionCard icon={icon} title="Hiring & payroll" description={description}>
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      </AiFrontDeskSectionCard>
    );
  }

  const s = data.settings;
  const locked = !canManage || update.isPending;
  const p = s.payroll;
  const emailChanged = email.trim().toLowerCase() !== (p.csvEmail ?? "");
  const anchorChanged = anchor !== p.anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(anchor);

  return (
    <AiFrontDeskSectionCard icon={icon} title="Hiring & payroll" description={description}>
      <div className="space-y-5">
        <section className="space-y-2">
          <Switch label={`Payroll ${p.enabled ? "on" : "off"}`} checked={p.enabled} disabled={locked} onChange={(on) => update.mutate({ payroll: { enabled: on } })} />
          <fieldset className={cn("space-y-3 pl-6", !p.enabled && "opacity-60")} disabled={locked || !p.enabled}>
            <p className="text-xs text-muted-foreground">
              The morning after each pay period ends (8am), you get a text with everyone's hours and overtime (over 44 hours a week, Ontario). Reply Y to lock the hours and email the CSV. This period: {day(data.currentPeriod.start)} - {day(data.currentPeriod.end)}; the text comes {day(data.nextAskOn)}.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs font-medium text-foreground">
                Pay period
                <select
                  className="mt-1 block h-8 rounded-md border border-border bg-background px-2 text-sm"
                  value={p.frequency}
                  onChange={(e) => update.mutate({ payroll: { frequency: e.target.value as Frequency } })}
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              {p.frequency !== "semimonthly" && (
                <label className="text-xs font-medium text-foreground">
                  A period starts on
                  <span className="mt-1 flex items-center gap-2">
                    <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-sm" />
                    <button type="button" className="h-8 px-3 rounded-md border border-border text-sm disabled:opacity-50" disabled={!anchorChanged} onClick={() => update.mutate({ payroll: { anchorDate: anchor } })}>
                      Save
                    </button>
                  </span>
                </label>
              )}
            </div>
            <label className="block text-xs font-medium text-foreground">
              Email the payroll CSV to
              <span className="mt-1 flex items-center gap-2">
                <input
                  type="email"
                  value={email}
                  placeholder={data.fallbackEmail ?? "you@example.com"}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-8 w-64 rounded-md border border-border bg-background px-2 text-sm"
                />
                <button type="button" className="h-8 px-3 rounded-md border border-border text-sm disabled:opacity-50" disabled={!emailChanged} onClick={() => update.mutate({ payroll: { csvEmail: email.trim() || null } })}>
                  Save
                </button>
              </span>
              <span className="block mt-1 font-normal text-muted-foreground">Your bookkeeper's email, or leave blank to send it to {data.fallbackEmail ?? "the account owner"}.</span>
            </label>
          </fieldset>

          {data.periods && data.periods.length > 0 && (
            <div className="pl-6">
              <p className="text-xs font-medium text-foreground mb-1">Recent pay periods</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.periods.map((period) => (
                  <li key={period.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                    <span className="font-medium text-foreground w-32">
                      {day(period.start)} - {day(period.end)}
                    </span>
                    <span className={cn("rounded px-1.5 py-0.5", period.status === "locked" ? "bg-secondary text-foreground" : "text-muted-foreground")}>{STATUS_LABEL[period.status] ?? period.status}</span>
                    {period.status !== "empty" && (
                      <span className="text-muted-foreground">
                        {period.people} {period.people === 1 ? "person" : "people"}, {hours(period.totalMinutes)}
                        {period.otMinutes > 0 ? `, OT ${hours(period.otMinutes)}` : ""}
                        {period.openEntries > 0 ? `, ${period.openEntries} open` : ""}
                      </span>
                    )}
                    {period.csvEmailError && <span className="text-amber-600 dark:text-amber-400">Email failed</span>}
                    <span className="ml-auto flex gap-1">
                      {canManage && period.status !== "empty" && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border"
                          onClick={() => downloadCsv(orgId, companyId, period).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Download failed"))}
                        >
                          <Download className="w-3 h-3" /> CSV
                        </button>
                      )}
                      {canManage && period.status === "locked" && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border disabled:opacity-50"
                          disabled={periodAction.isPending}
                          onClick={() => {
                            if (window.confirm("Unlock these hours so they can be edited? This is logged. Lock again to email a fresh CSV.")) periodAction.mutate({ periodId: period.id, action: "unlock" });
                          }}
                        >
                          <Unlock className="w-3 h-3" /> Unlock
                        </button>
                      )}
                      {canManage && ["unlocked", "skipped", "expired", "awaiting_owner"].includes(period.status) && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border disabled:opacity-50"
                          disabled={periodAction.isPending}
                          onClick={() => periodAction.mutate({ periodId: period.id, action: "lock" })}
                        >
                          <Lock className="w-3 h-3" /> Lock & email
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <Switch label={`Hiring ${s.hiring.enabled ? "on" : "off"}`} checked={s.hiring.enabled} disabled={locked} onChange={(on) => update.mutate({ hiring: { enabled: on } })} />
          <div className={cn("pl-6 space-y-2", !s.hiring.enabled && "opacity-60")}>
            <p className="text-xs text-muted-foreground">
              Text your assistant "I need a labourer, $22/hr, start Monday". It drafts the job post for your OK, puts it on your website with an apply form, and texts you copy for Indeed or Facebook. Applicants are sorted only on the job's requirements (never age, family, health or background) and nobody is turned away automatically: you get a list at 8:30am and choose who to call.
            </p>
            {!data.siteLive && s.hiring.enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Your website isn't live yet, so job posts have no apply page - people apply by texting your business number.</p>}
            {data.jobs && data.jobs.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.jobs.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                    <span className="font-medium text-foreground">{job.title}</span>
                    <span className="text-muted-foreground">{job.status === "open" ? "Open" : job.status === "closed" ? "Closed" : "Waiting on your OK"}</span>
                    <span className="text-muted-foreground">
                      {job.applicants} applied{job.newApplicants ? ` (${job.newApplicants} new)` : ""}
                    </span>
                    {job.url && (
                      <a className="ml-auto text-primary underline" href={job.url} target="_blank" rel="noreferrer">
                        Job page
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {!data.ownerPhoneOnFile && (p.enabled || s.hiring.enabled) && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to get the payroll and applicant texts.</p>}
        {!p.enabled && !s.hiring.enabled && !data.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn either on to start.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}
