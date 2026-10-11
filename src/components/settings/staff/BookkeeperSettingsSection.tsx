import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Wallet } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Bookkeeper (docs/ai-staff.md → "Bookkeeper"): reminder texts with
 * the pay link, the final notice (asks the owner first) and the 8am money alert. Self-contained
 * (own query + mutation), like CallAnsweringSettingsSection.
 */

export interface CollectionsSettings {
  enabled: boolean;
  enabledIsDefault: boolean;
  textReminders: boolean;
  reminderDays: number[];
  finalNotice: boolean;
  dailyAlert: boolean;
}

export interface CollectionsView {
  companyId: string;
  companyName: string;
  settings: CollectionsSettings;
  defaultEnabled: boolean;
  emailReminders: { enabled: boolean; days: number[] };
  ownerPhoneOnFile: boolean;
  stats: { overdueCount: number; overdueCents: number; outstandingCents: number; texts30d: number; activePlans: number; openPromises: number };
}

type Patch = Partial<Pick<CollectionsSettings, "enabled" | "textReminders" | "reminderDays" | "finalNotice" | "dailyAlert">>;

const path = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/collections`;

function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-CA")}`;
}

/** "3, 10, 20, 30" → [3, 10, 20, 30]; null when it isn't 1–6 whole days between 1 and 120. */
function parseReminderDays(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 6) return null;
  const days = parts.map((p) => Number(p));
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 120)) return null;
  return [...new Set(days)].sort((a, b) => a - b);
}

function Toggle({ label, help, checked, disabled, onChange }: { label: string; help: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={cn("flex items-start gap-2.5 p-2.5 rounded-lg border border-border", disabled ? "cursor-default" : "cursor-pointer hover:bg-secondary/60")}>
      <input type="checkbox" className="accent-primary mt-0.5 w-4 h-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground mt-0.5">{help}</span>
      </span>
    </label>
  );
}

export function BookkeeperSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["collections-settings", orgId, companyId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<CollectionsView>(path(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<CollectionsView>(path(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const [daysText, setDaysText] = useState("");
  useEffect(() => {
    if (data) setDaysText(data.settings.reminderDays.join(", "));
  }, [data]);

  const description = "Gets your invoices paid: friendly-then-firm reminder texts with the pay link, payment plans you OK, and a heads-up when money needs you.";

  if (isLoading) {
    return (
      <AiFrontDeskSectionCard icon={<Wallet className="w-4 h-4" />} title="Bookkeeper" description={description}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </AiFrontDeskSectionCard>
    );
  }
  if (error || !data) {
    return (
      <AiFrontDeskSectionCard icon={<Wallet className="w-4 h-4" />} title="Bookkeeper" description={description}>
        <p className="text-sm text-muted-foreground">Couldn't load these settings.</p>
      </AiFrontDeskSectionCard>
    );
  }

  const s = data.settings;
  const locked = !canManage || update.isPending;
  const parsedDays = parseReminderDays(daysText);
  const daysChanged = parsedDays !== null && parsedDays.join(",") !== s.reminderDays.join(",");
  const emailDays = data.emailReminders.enabled && data.emailReminders.days.length ? data.emailReminders.days.join(", ") : null;

  return (
    <AiFrontDeskSectionCard
      icon={<Wallet className="w-4 h-4" />}
      title="Bookkeeper"
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={locked}
            onChange={(e) => update.mutate({ enabled: e.target.checked })}
            className="accent-primary w-4 h-4"
            aria-label="Bookkeeper on"
          />
          <span className="text-sm font-medium text-foreground">{s.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{dollars(data.stats.outstandingCents)}</span> owed to you
          </span>
          <span>
            <span className="font-semibold text-foreground">{data.stats.overdueCount}</span> overdue ({dollars(data.stats.overdueCents)})
          </span>
          <span>
            <span className="font-semibold text-foreground">{data.stats.texts30d}</span> reminder texts in 30 days
          </span>
          {data.stats.activePlans > 0 && (
            <span>
              <span className="font-semibold text-foreground">{data.stats.activePlans}</span> payment plans
            </span>
          )}
          {data.stats.openPromises > 0 && (
            <span>
              <span className="font-semibold text-foreground">{data.stats.openPromises}</span> promised to pay
            </span>
          )}
        </div>

        <fieldset className={cn("space-y-2", !s.enabled && "opacity-60")} disabled={locked || !s.enabled}>
          <Toggle
            label="Reminder texts with the pay link"
            help="Overdue invoices get a short text from your number, friendly at first and firmer later. 9am-8pm, Monday to Saturday, never more than one every 5 days."
            checked={s.textReminders}
            disabled={locked || !s.enabled}
            onChange={(on) => update.mutate({ textReminders: on })}
          />
          <div className={cn("pl-9 space-y-1", !s.textReminders && "opacity-60")}>
            <label className="block text-xs font-medium text-foreground" htmlFor={`bk-days-${companyId}`}>
              Days after the due date
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`bk-days-${companyId}`}
                value={daysText}
                onChange={(e) => setDaysText(e.target.value)}
                disabled={locked || !s.enabled || !s.textReminders}
                className="h-8 w-40 rounded-md border border-border bg-background px-2 text-sm"
                inputMode="numeric"
              />
              <button
                type="button"
                className="h-8 px-3 rounded-md border border-border text-sm disabled:opacity-50"
                disabled={locked || !s.enabled || !s.textReminders || !daysChanged}
                onClick={() => parsedDays && update.mutate({ reminderDays: parsedDays })}
              >
                Save
              </button>
            </div>
            {parsedDays === null && <p className="text-xs text-destructive">Use up to 6 whole days between 1 and 120, e.g. 3, 10, 20, 30.</p>}
            <p className="text-xs text-muted-foreground">
              {emailDays
                ? `Email reminders go out on days ${emailDays} (Settings > Invoices). A text never goes the same day as an email.`
                : "Email reminders are off (Settings > Invoices), so texts are the only reminders."}
            </p>
          </div>
          <Toggle
            label="Final notice (asks you first)"
            help="A week after the last reminder, we text you the exact final reminder for your OK. It never threatens anything - it just says it's the final reminder and offers a payment plan."
            checked={s.finalNotice}
            disabled={locked || !s.enabled || !s.textReminders}
            onChange={(on) => update.mutate({ finalNotice: on })}
          />
          <Toggle
            label="Morning money alert"
            help="One text at 8am, only when something needs you: an invoice hits 30 or 60 days late, a payment fails, a promise to pay is missed, or your books stop syncing."
            checked={s.dailyAlert}
            disabled={locked || !s.enabled}
            onChange={(on) => update.mutate({ dailyAlert: on })}
          />
        </fieldset>

        <p className="text-xs text-muted-foreground">
          Customers can also text back to ask what they owe, get the pay link, say when they'll pay, or ask for a payment plan (you OK every plan). Text "who owes me" or "Jones paid $500 by e-transfer" to your assistant any time.
        </p>
        {!data.ownerPhoneOnFile && s.enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to get approvals and the money alert by text.</p>}
        {!s.enabled && s.enabledIsDefault && !data.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn it on to start chasing overdue invoices by text.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}
