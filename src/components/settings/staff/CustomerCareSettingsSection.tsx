import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartHandshake, Loader2, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Customer care & warranty (docs/ai-staff.md): on/off, the post-job
 * check-in (time, how many days after, minimum job size), the default workmanship warranty and
 * per-service overrides, installed equipment, and — for owners/admins — the open cases. Self-contained.
 */

export interface CustomerCareView {
  companyId: string;
  companyName: string;
  settings: {
    enabled: boolean;
    enabledIsDefault: boolean;
    defaultEnabled: boolean;
    checkins: { enabled: boolean; time: string; delayDays: number; minJobCents: number };
    warranty: { months: number; terms: string | null };
  };
  smsAgentOn: boolean;
  ownerPhoneOnFile: boolean;
  stats: { checkinsSent30: number; answered30: number; averageRating: number | null; ratings30: number; openCases: number };
  cases: Array<{ id: string; customer: string; phone: string | null; kind: "complaint" | "callback" | "warranty"; status: string; rating: number | null; summary: string | null; job: string | null; opened: string; stage: string | null }> | null;
  catalog: Array<{ id: string; label: string; months: number | null; terms: string | null }>;
  equipment: Array<{ id: string; customer: string; name: string; serial: string | null; installedOn: string | null; warrantyEnds: string | null }>;
}

type Patch = {
  enabled?: boolean;
  checkins?: { enabled?: boolean; time?: string; delayDays?: number; minJobCents?: number };
  warranty?: { months?: number; terms?: string | null };
};
type EquipmentForm = { customer: string; make: string; model: string; serial: string; installedOn: string; warrantyEnds: string };
type Action =
  | { action: "save_term"; catalogItemId: string; months: number | null }
  | { action: "save_equipment"; equipment: { customer: string; make: string | null; model: string | null; serial: string | null; installedOn: string | null; warrantyEnds: string | null } }
  | { action: "remove_equipment"; equipmentId: string }
  | { action: "resolve_case"; caseId: string; outcome: "resolved" | "closed" };

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/customer-care`;
const TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
const MONTHS = [0, 3, 6, 12, 24, 36, 60, 120];
const MIN_JOB = [0, 100, 250, 500, 1000, 2500];
const KIND: Record<string, string> = { complaint: "Unhappy", callback: "Callback", warranty: "Warranty" };
const inputCls = "h-8 rounded-md border border-border bg-background px-2 text-sm";
const monthsLabel = (m: number) => (m === 0 ? "No warranty" : m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`);
const timeLabel = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

const EMPTY_FORM: EquipmentForm = { customer: "", make: "", model: "", serial: "", installedOn: "", warrantyEnds: "" };

export function CustomerCareSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["customer-care-settings", orgId, companyId];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<EquipmentForm>(EMPTY_FORM);
  const [terms, setTerms] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<CustomerCareView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const onDone = (view: CustomerCareView) => {
    qc.setQueryData(queryKey, view);
    toast.success("Saved");
  };
  const onError = (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save");
  const update = useMutation({ mutationFn: (patch: Patch) => apiFetch<CustomerCareView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }), onSuccess: onDone, onError });
  const act = useMutation({
    mutationFn: (body: Action) => apiFetch<CustomerCareView>(path(orgId, companyId), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (view, body) => {
      onDone(view);
      if (body.action === "save_equipment") {
        setAdding(false);
        setForm(EMPTY_FORM);
      }
    },
    onError,
  });

  const title = "Customer care & warranty";
  const description = "Checks in with each customer the day after a job, tells you right away when someone isn't happy, and handles callbacks and warranty visits with your OK.";
  const icon = <HeartHandshake className="w-4 h-4" />;

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
  const termsValue = terms ?? s.warranty.terms ?? "";
  const saveEquipment = () => {
    const clean = (v: string) => v.trim() || null;
    act.mutate({
      action: "save_equipment",
      equipment: { customer: form.customer.trim(), make: clean(form.make), model: clean(form.model), serial: clean(form.serial), installedOn: clean(form.installedOn), warrantyEnds: clean(form.warrantyEnds) },
    });
  };

  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title={title}
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input type="checkbox" checked={s.enabled} disabled={locked} onChange={(e) => update.mutate({ enabled: e.target.checked })} className="accent-primary w-4 h-4" aria-label="Customer care on" />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className="space-y-4">
        {s.enabled && !data.smsAgentOn && (
          <p className="text-xs text-amber-600 dark:text-amber-400">Turn on Text conversations above too: customers answer the check-in and pick visit times through your texting assistant.</p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          <Stat label="Check-ins (30 days)" value={String(data.stats.checkinsSent30)} />
          <Stat label="Answered" value={String(data.stats.answered30)} />
          <Stat label="Average rating" value={data.stats.averageRating != null ? `${data.stats.averageRating}/5` : "-"} />
          <Stat label="Open cases" value={String(data.stats.openCases)} />
        </div>

        <fieldset className={cn("space-y-2", !s.enabled && "opacity-60")} disabled={locked || !s.enabled}>
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="accent-primary mt-0.5 w-4 h-4" checked={s.checkins.enabled} onChange={(e) => update.mutate({ checkins: { enabled: e.target.checked } })} aria-label="Check-ins on" />
            <span>
              <span className="block font-medium text-foreground">Check in after each job</span>
              <span className="block text-xs text-muted-foreground">
                "Hi Dana, it's {data.companyName} - how did the job go? Reply 1-5 (5 = great), or tell us anything we missed." A 1-3 comes straight to you. Your review requests go out exactly as before, whatever the answer.
              </span>
            </span>
          </label>
          <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-sm pl-6", !s.checkins.enabled && "opacity-60")}>
            <label className="flex items-center gap-2">
              Send
              <select aria-label="Days after the job" value={s.checkins.delayDays} disabled={!s.checkins.enabled} onChange={(e) => update.mutate({ checkins: { delayDays: Number(e.target.value) } })} className={inputCls}>
                {[1, 2, 3, 5, 7].map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "the next day" : `${d} days after`}
                  </option>
                ))}
              </select>
              at
              <select aria-label="Check-in time" value={s.checkins.time} disabled={!s.checkins.enabled} onChange={(e) => update.mutate({ checkins: { time: e.target.value } })} className={inputCls}>
                {(TIMES.includes(s.checkins.time) ? TIMES : [s.checkins.time, ...TIMES]).map((t) => (
                  <option key={t} value={t}>
                    {timeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              Skip jobs under
              <select aria-label="Minimum job size" value={s.checkins.minJobCents} disabled={!s.checkins.enabled} onChange={(e) => update.mutate({ checkins: { minJobCents: Number(e.target.value) } })} className={inputCls}>
                {(MIN_JOB.map((d) => d * 100).includes(s.checkins.minJobCents) ? MIN_JOB.map((d) => d * 100) : [s.checkins.minJobCents, ...MIN_JOB.map((d) => d * 100)]).map((c) => (
                  <option key={c} value={c}>
                    {c === 0 ? "no minimum" : `$${(c / 100).toLocaleString("en-CA")}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset className={cn("space-y-2", !s.enabled && "opacity-60")} disabled={locked || !s.enabled}>
          <h4 className="text-xs font-semibold text-foreground">Workmanship warranty</h4>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              Every job:
              <select aria-label="Default warranty" value={s.warranty.months} onChange={(e) => update.mutate({ warranty: { months: Number(e.target.value) } })} className={inputCls}>
                {(MONTHS.includes(s.warranty.months) ? MONTHS : [s.warranty.months, ...MONTHS]).map((m) => (
                  <option key={m} value={m}>
                    {monthsLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <input
              aria-label="Warranty terms"
              placeholder="Terms (optional), e.g. covers leaks from our work, not storm damage"
              value={termsValue}
              onChange={(e) => setTerms(e.target.value)}
              onBlur={() => {
                if (terms != null && terms !== (s.warranty.terms ?? "")) update.mutate({ warranty: { terms: terms.trim() || null } });
              }}
              className={cn(inputCls, "flex-1 min-w-[12rem]")}
            />
          </div>
          {data.catalog.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">Different warranty for some services</summary>
              <ul className="mt-2 space-y-1">
                {data.catalog.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{item.label}</span>
                    <select
                      aria-label={`Warranty for ${item.label}`}
                      value={item.months == null ? "" : String(item.months)}
                      disabled={!canManage || act.isPending}
                      onChange={(e) => act.mutate({ action: "save_term", catalogItemId: item.id, months: e.target.value === "" ? null : Number(e.target.value) })}
                      className={inputCls}
                    >
                      <option value="">Same as every job</option>
                      {MONTHS.map((m) => (
                        <option key={m} value={m}>
                          {monthsLabel(m)}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-xs text-muted-foreground">Each finished job gets a warranty record. When a customer texts about a problem, your assistant checks it and asks you - it never tells them it's covered.</p>
        </fieldset>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">Installed equipment</h4>
          {data.equipment.length === 0 && !adding && <p className="text-xs text-muted-foreground">Nothing yet. Add furnaces, heat pumps, water heaters… with their manufacturer warranty, or text your assistant "add equipment".</p>}
          {data.equipment.length > 0 && (
            <ul className="rounded-lg border border-border divide-y divide-border text-sm">
              {data.equipment.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-2 px-2.5 py-2">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{e.name}</span> <span className="text-muted-foreground">· {e.customer}</span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {[e.serial ? `SN ${e.serial}` : null, e.installedOn ? `installed ${e.installedOn}` : null, e.warrantyEnds ? `warranty to ${e.warrantyEnds}` : "no warranty date"].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {canManage && (
                    <button type="button" aria-label={`Remove ${e.name}`} onClick={() => act.mutate({ action: "remove_equipment", equipmentId: e.id })} className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground shrink-0">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage &&
            (adding ? (
              <div className="rounded-lg border border-border p-2.5 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(
                    [
                      ["customer", "Customer name or phone", "text"],
                      ["make", "Make (e.g. Lennox)", "text"],
                      ["model", "Model", "text"],
                      ["serial", "Serial number", "text"],
                      ["installedOn", "Installed", "date"],
                      ["warrantyEnds", "Manufacturer warranty ends", "date"],
                    ] as Array<[keyof EquipmentForm, string, string]>
                  ).map(([key, label, type]) => (
                    <label key={key} className="text-xs text-muted-foreground space-y-1">
                      <span className="block">{label}</span>
                      <input aria-label={label} type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={cn(inputCls, "w-full")} />
                    </label>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={act.isPending || form.customer.trim().length < 2 || (!form.make.trim() && !form.model.trim())} onClick={saveEquipment} className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">
                    Save
                  </button>
                  <button type="button" onClick={() => setAdding(false)} className="h-8 px-3 rounded-md border border-border text-sm">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setAdding(true)} className="h-8 px-3 rounded-md border border-border text-sm flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add equipment
              </button>
            ))}
        </div>

        {data.cases && data.cases.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-foreground">Open cases</h4>
            <ul className="rounded-lg border border-border divide-y divide-border text-sm">
              {data.cases.map((c) => (
                <li key={c.id} className="px-2.5 py-2">
                  <span className="flex justify-between gap-2">
                    <span className="font-medium text-foreground truncate">
                      {c.customer} · {KIND[c.kind] ?? c.kind}
                      {c.rating != null ? ` ${c.rating}/5` : ""}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{c.status === "scheduled" ? "visit booked" : (c.stage ?? "open")}</span>
                  </span>
                  {c.summary && <span className="block text-xs text-muted-foreground truncate">"{c.summary}"</span>}
                  {canManage && (
                    <span className="flex gap-2 mt-1">
                      <button type="button" disabled={act.isPending} onClick={() => act.mutate({ action: "resolve_case", caseId: c.id, outcome: "resolved" })} className="h-7 px-2 rounded-md border border-border text-xs">
                        Resolved
                      </button>
                      <button type="button" disabled={act.isPending} onClick={() => act.mutate({ action: "resolve_case", caseId: c.id, outcome: "closed" })} className="h-7 px-2 rounded-md border border-border text-xs">
                        Close
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">Text your assistant "care status", "warranty for Dana Jones" or "Dana's sorted". Callback and warranty visits are never invoiced automatically.</p>
        {!data.ownerPhoneOnFile && s.enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to hear about unhappy customers by text.</p>}
        {!s.enabled && s.enabledIsDefault && !s.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn it on to check in after jobs.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border px-2.5 py-1.5">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <span className="block font-semibold text-foreground">{value}</span>
    </div>
  );
}
