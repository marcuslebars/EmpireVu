import { useEffect, useState } from "react";
import { CalendarCheck, CheckCircle2, Loader2, Link2 } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { useCompanies } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { CUTOFF_OPTIONS, useAddLinkToReminders, useSaveVisitSettings, useVisitSettings, type VisitSettingsValues } from "@/lib/visits-api";
import { cn } from "@/lib/utils";

const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const hintCls = "text-xs text-muted-foreground mt-1";
const selectCls =
  "w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-60";

function cutoffLabel(h: number): string {
  if (h === 0) return "Any time before the visit";
  if (h < 24) return `Up to ${h} hours before`;
  return `Up to ${h / 24} day${h === 24 ? "" : "s"} before`;
}

function Panel({ orgId, companyId, canManage }: { orgId: string; companyId: string; canManage: boolean }) {
  const { data, isLoading } = useVisitSettings(orgId, companyId);
  const save = useSaveVisitSettings(orgId, companyId);
  const addLink = useAddLinkToReminders(orgId, companyId);
  const [form, setForm] = useState<VisitSettingsValues | null>(null);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  if (isLoading || !form || !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }

  const persist = async (patch: Partial<VisitSettingsValues>) => {
    const next = { ...form, ...patch };
    setForm(next);
    try {
      await save.mutateAsync(patch);
      toast.success("Saved");
    } catch (err) {
      setForm(data.settings);
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  const onAddLink = async () => {
    try {
      await addLink.mutateAsync();
      toast.success("Link added to your reminders");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the reminders.");
    }
  };

  const disabled = !canManage || save.isPending;
  const missing = data.reminders.filter((r) => !r.hasLink);

  return (
    <div className="space-y-6">
      {!canManage && <p className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2">Only owners and admins can change these settings.</p>}

      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <p className="text-sm font-medium text-foreground flex items-center gap-2">
          <Link2 className="w-4 h-4 text-muted-foreground" /> The link in your reminders
        </p>
        <p className={hintCls}>
          Every visit has its own private page where the customer can confirm, pick a new time or cancel. Reminder texts carry it as{" "}
          <code className="text-foreground">{"{{booking.manage_url}}"}</code> — it opens on your own domain ({data.linkBase.replace(/^https?:\/\//, "")}…).
        </p>
        {data.reminders.length === 0 ? (
          <p className="text-xs text-muted-foreground">No reminder automation yet — add "Booking reminders" under Automations; it includes the link.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.reminders.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground">
                  {r.name} <span className="text-xs text-muted-foreground">· {r.status}</span>
                </span>
                {r.hasLink ? (
                  <span className="flex items-center gap-1 text-xs text-[hsl(var(--success))]">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Has the link
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">No link yet</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 && canManage && (
          <button type="button" onClick={() => void onAddLink()} disabled={addLink.isPending} className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50">
            {addLink.isPending ? "Adding…" : `Add the link to ${missing.length === 1 ? "this reminder" : `these ${missing.length} reminders`}`}
          </button>
        )}
      </div>

      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Customers can move their visit</p>
            <p className={hintCls}>They pick from your open times; you and the crew get a notification.</p>
          </div>
          <Switch checked={form.allowReschedule} onCheckedChange={(v) => void persist({ allowReschedule: v })} disabled={disabled} aria-label="Customers can move their visit" />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Customers can cancel</p>
            <p className={hintCls}>You get a notification and a task to follow up and rebook.</p>
          </div>
          <Switch checked={form.allowCancel} onCheckedChange={(v) => void persist({ allowCancel: v })} disabled={disabled} aria-label="Customers can cancel" />
        </div>
        <div className="max-w-xs">
          <label htmlFor="visit-cutoff" className={labelCls}>
            Changes allowed
          </label>
          <select id="visit-cutoff" value={form.cutoffHours} onChange={(e) => void persist({ cutoffHours: Number(e.target.value) })} disabled={disabled} className={selectCls}>
            {CUTOFF_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {cutoffLabel(h)}
              </option>
            ))}
            {!CUTOFF_OPTIONS.includes(form.cutoffHours) && <option value={form.cutoffHours}>{cutoffLabel(form.cutoffHours)}</option>}
          </select>
          <p className={hintCls}>Closer to the visit, the page asks them to call or text instead. Confirming always works.</p>
        </div>
      </div>
    </div>
  );
}

export function VisitSettings() {
  const { organizationId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canManage = role === "owner" || role === "admin";
  const { data: companies, isLoading } = useCompanies(organizationId);
  const [picked, setPicked] = useState<string | null>(null);
  const list = companies ?? [];
  const companyId = picked && list.some((c) => c.id === picked) ? picked : (list[0]?.id ?? null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <CalendarCheck className="w-4 h-4 text-muted-foreground" /> Confirm &amp; reschedule
        </h2>
        <p className="text-sm text-muted-foreground mt-1">Let customers confirm, move or cancel a visit from the reminder text.</p>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading companies…
        </div>
      ) : list.length === 0 ? (
        <div className="text-sm text-muted-foreground px-3 py-2.5 bg-secondary rounded-lg">No companies yet. Add a company under the Organization tab first.</div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-1 bg-secondary/50 rounded-lg p-1 border border-border w-fit max-w-full">
              {list.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setPicked(c.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium transition-all truncate max-w-[200px]",
                    c.id === companyId ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {companyId && <Panel key={companyId} orgId={organizationId} companyId={companyId} canManage={canManage} />}
        </>
      )}
    </div>
  );
}
