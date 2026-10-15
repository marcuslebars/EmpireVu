import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Service plans (docs/ai-staff.md → "Service plans"): the maintenance
 * plans the business sells (a simple editor), its sign-up page, renewals / visit texts on-off, and
 * (owners/admins) who's on a plan, with Cancel. Self-contained (own query + mutations). Renders
 * nothing for house orgs (Service plans is done-for-you-only).
 */

type Billing = "annual" | "per_visit";

export interface PlanView {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  billing: Billing;
  months: number[];
  weekday: number;
  week: number;
  timeOfDay: string;
  durationMinutes: number;
  included: string[];
  active: boolean;
  customers: number;
}

export interface AgreementView {
  id: string;
  customer: string;
  planName: string;
  status: string;
  billing: Billing;
  priceCents: number;
  termStart: string | null;
  termEnd: string | null;
  nextVisit: string | null;
  renewalTexted: boolean;
}

export interface ServicePlansView {
  companyId: string;
  companyName: string;
  available: boolean;
  settings: { enabled: boolean; headsUp: { enabled: boolean }; renewals: { enabled: boolean } };
  stripeReady: boolean;
  plansUrl: string | null;
  plans: PlanView[];
  counts: { active: number; renewingSoon: number; unpaidRenewals: number; lapsed: number; waiting: number; annualRevenueCents: number };
  agreements: AgreementView[] | null;
}

interface PlanDraft {
  name: string;
  description: string;
  price: string;
  billing: Billing;
  months: number[];
  weekday: number;
  week: number;
  timeOfDay: string;
  durationMinutes: number;
  included: string;
  active: boolean;
}

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/service-plans`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKS = ["First", "Second", "Third", "Fourth"];
const STATUS: Record<string, string> = {
  pending_owner: "Waiting on you",
  pending_payment: "Waiting on payment",
  active: "Active",
  renewal_due: "Renewal due",
  lapsed: "Lapsed",
  cancelled: "Cancelled",
};

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function emptyDraft(): PlanDraft {
  return { name: "", description: "", price: "", billing: "annual", months: [5, 10], weekday: 1, week: 1, timeOfDay: "09:00", durationMinutes: 60, included: "", active: true };
}

function draftOf(p: PlanView): PlanDraft {
  return {
    name: p.name,
    description: p.description ?? "",
    price: (p.priceCents / 100).toFixed(p.priceCents % 100 ? 2 : 0),
    billing: p.billing,
    months: p.months,
    weekday: p.weekday,
    week: p.week,
    timeOfDay: p.timeOfDay,
    durationMinutes: p.durationMinutes,
    included: p.included.join("\n"),
    active: p.active,
  };
}

/** The editor's draft → the route's plan body, or an error to show. */
function planBody(d: PlanDraft): { ok: true; plan: Record<string, unknown> } | { ok: false; error: string } {
  const priceCents = Math.round(Number(d.price.replace(/[$,\s]/g, "")) * 100);
  if (d.name.trim().length < 2) return { ok: false, error: "Give the plan a name." };
  if (!Number.isFinite(priceCents) || priceCents < 100) return { ok: false, error: "Enter a price of at least $1." };
  if (d.months.length === 0) return { ok: false, error: "Pick at least one visit month." };
  return {
    ok: true,
    plan: {
      name: d.name.trim(),
      description: d.description.trim() || null,
      priceCents,
      billing: d.billing,
      months: [...d.months].sort((a, b) => a - b),
      weekday: d.weekday,
      week: d.week,
      timeOfDay: d.timeOfDay,
      durationMinutes: d.durationMinutes,
      included: d.included
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10),
      active: d.active,
    },
  };
}

function PlanEditor({ initial, saving, onSave, onCancel }: { initial: PlanDraft; saving: boolean; onSave: (d: PlanDraft) => void; onCancel: () => void }) {
  const [d, setD] = useState<PlanDraft>(initial);
  const set = (patch: Partial<PlanDraft>) => setD((prev) => ({ ...prev, ...patch }));
  const toggleMonth = (m: number) => set({ months: d.months.includes(m) ? d.months.filter((x) => x !== m) : [...d.months, m] });
  const input = "h-8 rounded-md border border-border bg-background px-2 text-sm";
  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium text-foreground">Plan name</span>
          <input className={cn(input, "w-full")} value={d.name} maxLength={80} placeholder="Spring + Fall Lawn Care" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="flex gap-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Price (before HST)</span>
            <input className={cn(input, "w-28")} inputMode="decimal" value={d.price} placeholder="420" onChange={(e) => set({ price: e.target.value })} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Billed</span>
            <select className={cn(input, "block")} value={d.billing} onChange={(e) => set({ billing: e.target.value as Billing })}>
              <option value="annual">per year, paid up front</option>
              <option value="per_visit">per visit</option>
            </select>
          </label>
        </div>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium text-foreground">Description</span>
        <input className={cn(input, "w-full")} value={d.description} maxLength={1000} placeholder="Two visits a year to keep your lawn healthy." onChange={(e) => set({ description: e.target.value })} />
      </label>
      <div className="space-y-1">
        <span className="text-sm font-medium text-foreground">Visit months</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Visit months">
          {MONTHS.map((label, i) => {
            const m = i + 1;
            const on = d.months.includes(m);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => toggleMonth(m)}
                className={cn("h-8 w-11 rounded-md border text-xs font-medium", on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground")}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="space-y-1">
          <span className="font-medium text-foreground">Which day</span>
          <select className={cn(input, "block")} value={d.week} onChange={(e) => set({ week: Number(e.target.value) })}>
            {WEEKS.map((w, i) => (
              <option key={w} value={i + 1}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <select className={input} aria-label="Weekday" value={d.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
          {WEEKDAYS.map((w, i) => (
            <option key={w} value={i}>
              {w}
            </option>
          ))}
        </select>
        <span className="pb-1.5 text-muted-foreground">of the month, at</span>
        <input type="time" className={input} aria-label="Start time" value={d.timeOfDay} onChange={(e) => set({ timeOfDay: e.target.value })} />
        <label className="space-y-1">
          <span className="font-medium text-foreground">Visit length</span>
          <select className={cn(input, "block")} value={d.durationMinutes} onChange={(e) => set({ durationMinutes: Number(e.target.value) })}>
            {[30, 60, 90, 120, 180, 240, 480].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium text-foreground">Every visit includes (one per line)</span>
        <textarea className="min-h-[72px] w-full rounded-md border border-border bg-background px-2 py-1 text-sm" value={d.included} onChange={(e) => set({ included: e.target.value })} placeholder={"Aerate the lawn\nFertilize"} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-primary h-4 w-4" checked={d.active} onChange={(e) => set({ active: e.target.checked })} />
        On sale (shown on your plans page)
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={saving} onClick={() => onSave(d)} className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {saving ? "Saving…" : "Save plan"}
        </button>
        <button type="button" onClick={onCancel} className="h-8 rounded-md border border-border px-3 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ServicePlansSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["service-plans-settings", orgId, companyId];
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<ServicePlansView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch<ServicePlansView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const action = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch<ServicePlansView>(path(orgId, companyId), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      setEditing(null);
      toast.success("Done");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "That didn't work"),
  });

  const title = "Service plans";
  const description = "Sell maintenance plans: customers sign up on your site, visits book themselves, and renewals are chased for you.";
  const icon = <CalendarClock className="w-4 h-4" />;

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
  if (!data.available) return null;

  const s = data.settings;
  const locked = !canManage || patch.isPending;
  const save = (body: PlanDraft, planId?: string) => {
    const built = planBody(body);
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    action.mutate(planId ? { action: "update_plan", planId, plan: built.plan } : { action: "create_plan", plan: built.plan });
  };

  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title={title}
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input type="checkbox" checked={s.enabled} disabled={locked} onChange={(e) => patch.mutate({ enabled: e.target.checked })} className="accent-primary w-4 h-4" aria-label="Service plans on" />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {data.counts.active} customer{data.counts.active === 1 ? "" : "s"} on a plan
          {data.counts.annualRevenueCents ? ` (${money(data.counts.annualRevenueCents)}/yr)` : ""}
          {data.counts.renewingSoon ? ` · ${data.counts.renewingSoon} renewing in 30 days` : ""}
          {data.counts.unpaidRenewals ? ` · ${data.counts.unpaidRenewals} renewal${data.counts.unpaidRenewals === 1 ? "" : "s"} unpaid` : ""}
          {data.counts.waiting ? ` · ${data.counts.waiting} sign-up${data.counts.waiting === 1 ? "" : "s"} waiting` : ""}.
        </p>
        {data.plansUrl ? (
          <p className="text-sm">
            Sign-up page:{" "}
            <a className="text-primary underline" href={data.plansUrl} target="_blank" rel="noreferrer">
              {data.plansUrl}
            </a>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Your sign-up page appears once your website is live and a plan is on sale.</p>
        )}
        {!data.stripeReady && <p className="text-sm text-muted-foreground">Card payments aren't set up, so every sign-up comes to you for an OK by text (yearly plans get an invoice).</p>}

        <div className="space-y-2">
          {data.plans.map((p) =>
            editing === p.id ? (
              <PlanEditor key={p.id} initial={draftOf(p)} saving={action.isPending} onSave={(d) => save(d, p.id)} onCancel={() => setEditing(null)} />
            ) : (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="text-sm">
                  <span className="font-medium text-foreground">{p.name}</span>{" "}
                  <span className="text-muted-foreground">
                    {money(p.priceCents)}/{p.billing === "annual" ? "yr" : "visit"} · {p.months.map((m) => MONTHS[m - 1]).join(" + ")} · {p.customers} customer{p.customers === 1 ? "" : "s"}
                    {p.active ? "" : " · not on sale"}
                  </span>
                </div>
                {canManage && (
                  <button type="button" className="h-7 rounded-md border border-border px-2 text-xs" onClick={() => setEditing(p.id)}>
                    Edit
                  </button>
                )}
              </div>
            ),
          )}
          {canManage &&
            (editing === "new" ? (
              <PlanEditor initial={emptyDraft()} saving={action.isPending} onSave={(d) => save(d)} onCancel={() => setEditing(null)} />
            ) : (
              <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-sm" onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" /> Add a plan
              </button>
            ))}
        </div>

        <fieldset className={cn("space-y-2", !s.enabled && "opacity-60")} disabled={locked || !s.enabled}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary h-4 w-4" checked={s.renewals.enabled} onChange={(e) => patch.mutate({ renewals: { enabled: e.target.checked } })} />
            Ask me every Monday about plans renewing in the next 30 days (Y texts each customer their renewal link)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary h-4 w-4" checked={s.headsUp.enabled} onChange={(e) => patch.mutate({ headsUp: { enabled: e.target.checked } })} />
            Text plan customers about 10 days before each visit
          </label>
        </fieldset>

        {data.agreements && data.agreements.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">Customers</p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.agreements.slice(0, 50).map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium text-foreground">{a.customer}</span> <span className="text-muted-foreground">· {a.planName} · {STATUS[a.status] ?? a.status}</span>
                    {a.termEnd ? <span className="text-muted-foreground"> · until {a.termEnd}</span> : null}
                    {a.nextVisit ? <span className="text-muted-foreground"> · next visit {a.nextVisit}</span> : null}
                  </span>
                  {canManage && ["pending_owner", "pending_payment", "active", "renewal_due"].includes(a.status) && (
                    <button
                      type="button"
                      className="h-7 rounded-md border border-border px-2 text-xs"
                      disabled={action.isPending}
                      onClick={() => {
                        if (window.confirm(`Cancel ${a.customer}'s ${a.planName}? Upcoming visits nobody has touched come off the calendar. Nothing is refunded automatically.`)) action.mutate({ action: "cancel_agreement", agreementId: a.id });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </AiFrontDeskSectionCard>
  );
}
