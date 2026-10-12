import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Receipt } from "lucide-react";

import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { apiFetch } from "@/lib/api-client";
import { AiFrontDeskSectionCard, type AiFrontDeskSectionProps } from "@/components/settings/AiFrontDeskSettings";

/**
 * Settings → AI front desk → Receipts & HST (docs/ai-staff.md → "Receipts & HST"): receipts by
 * text on/off, receipt pictures waiting for a total, the HST set-up (registrant, filing
 * frequency, fiscal year end, accountant email, reminders), this period's worksheet with
 * "Email the packet now", and the receipt nudges. Self-contained (own query + mutations).
 */

type Frequency = "monthly" | "quarterly" | "annual";
type Filer = "individual" | "corporation";

export interface TaxClerkView {
  companyId: string;
  companyName: string;
  settings: {
    receipts: { enabled: boolean };
    hst: { registrantSetting: boolean | null; registrant: boolean; frequency: Frequency; fiscalYearEndMonth: number; filer: Filer; reminders: boolean; accountantEmail: string | null };
    nudges: { weekly: boolean; tip: boolean };
    defaultEnabled: boolean;
  };
  defaultEnabled: boolean;
  hstNumberOnFile: boolean;
  remindersActive: boolean;
  ownerPhoneOnFile: boolean;
  hst: {
    period: { label: string; range: string; start: string; end: string; dueDate: string; paymentDueDate: string; toDate: boolean };
    salesCents: number;
    collectedCents: number;
    itcCents: number;
    netCents: number;
    missingReceipts: number;
    importedExcluded: number;
    packet: { emailedAt: string | null; emailedTo: string | null; error: string | null; sendsTo: string | null };
    disclaimer: string;
  } | null;
  toFinish: Array<{ id: string; vendor: string | null; spentOn: string | null; taxCents: number | null; category: string | null; createdAt: string; pictureUrl: string | null; missing: string[] }> | null;
  recent: Array<{ id: string; status: string; vendor: string | null; amountCents: number | null; createdAt: string; poReference: string | null }> | null;
}

type Patch = {
  receipts?: { enabled?: boolean };
  hst?: { registrant?: boolean | null; frequency?: Frequency; fiscalYearEndMonth?: number; filer?: Filer; reminders?: boolean; accountantEmail?: string | null };
  nudges?: { weekly?: boolean; tip?: boolean };
};

const base = (orgId: string, companyId: string) => `/api/organizations/${orgId}/companies/${companyId}/ai-settings/tax-clerk`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function money(cents: number): string {
  const abs = Math.abs(cents);
  const s = `$${(abs / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return cents < 0 ? `-${s}` : s;
}

function day(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

function lastDayOf(month: number): number {
  return new Date(Date.UTC(2025, month, 0)).getUTCDate();
}

const STATUS_WORD: Record<string, string> = { filed: "Filed", duplicate: "Duplicate (skipped)", needs_review: "Needs a total" };

function FinishRow({ item, disabled, onFile, onDiscard }: { item: NonNullable<TaxClerkView["toFinish"]>[number]; disabled: boolean; onFile: (amountCents: number, taxCents: number | undefined, spentOn: string | undefined) => void; onDiscard: () => void }) {
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState(item.taxCents != null ? (item.taxCents / 100).toFixed(2) : "");
  const [date, setDate] = useState(item.spentOn ?? "");
  const cents = (v: string) => {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  };
  const submit = () => {
    const a = cents(amount);
    const t = tax.trim() ? cents(tax) : undefined;
    if (!(a > 0)) {
      toast.error("Enter the total.");
      return;
    }
    if (t !== undefined && (Number.isNaN(t) || t > a)) {
      toast.error("The HST can't be more than the total.");
      return;
    }
    onFile(a, t, date || undefined);
  };
  return (
    <li className="rounded-lg border border-border p-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{item.vendor ?? "Receipt"}</span>
        <span className="text-xs text-muted-foreground">
          Texted {new Date(item.createdAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
          {item.pictureUrl && (
            <>
              {" · "}
              <a href={item.pictureUrl} target="_blank" rel="noreferrer" className="underline">
                See picture
              </a>
            </>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          Total
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="84.20" className="block h-8 w-24 rounded-md border border-border bg-background px-2 text-sm" />
        </label>
        <label className="text-xs text-muted-foreground">
          HST
          <input value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" placeholder="9.69" className="block h-8 w-20 rounded-md border border-border bg-background px-2 text-sm" />
        </label>
        <label className="text-xs text-muted-foreground">
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="block h-8 rounded-md border border-border bg-background px-2 text-sm" />
        </label>
        <button type="button" disabled={disabled} onClick={submit} className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">
          File it
        </button>
        <button type="button" disabled={disabled} onClick={onDiscard} className="h-8 px-3 rounded-md border border-border text-sm text-muted-foreground disabled:opacity-50">
          Throw away
        </button>
      </div>
    </li>
  );
}

export function TaxClerkSettingsSection({ orgId, companyId, canManage }: AiFrontDeskSectionProps) {
  const qc = useQueryClient();
  const queryKey = ["tax-clerk-settings", orgId, companyId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => apiFetch<TaxClerkView>(base(orgId, companyId)),
    enabled: Boolean(orgId && companyId),
    staleTime: 30_000,
  });
  const [email, setEmail] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (patch: Patch) => apiFetch<TaxClerkView>(base(orgId, companyId), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      setEmail(null);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const finish = useMutation({
    mutationFn: (body: { id: string; action: "file" | "discard"; amountCents?: number; taxCents?: number; spentOn?: string }) =>
      apiFetch<TaxClerkView>(`${base(orgId, companyId)}/receipts`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Done");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not save"),
  });
  const packet = useMutation({
    mutationFn: () => apiFetch<TaxClerkView>(`${base(orgId, companyId)}/packet`, { method: "POST" }),
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      toast.success("Packet emailed");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not send"),
  });

  const title = "Receipts & HST";
  const description = "Text a photo of any receipt and it's filed as an expense with the HST. Your HST worksheet, a reminder 10 days before it's due, and a packet for your accountant.";
  const icon = <Receipt className="w-4 h-4" />;

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
  const emailValue = email ?? s.hst.accountantEmail ?? "";
  const registrantValue = s.hst.registrantSetting === null ? "auto" : s.hst.registrantSetting ? "yes" : "no";

  return (
    <AiFrontDeskSectionCard
      icon={icon}
      title={title}
      description={description}
      aside={
        <label className={cn("flex items-center gap-2", canManage ? "cursor-pointer" : "cursor-default")}>
          <input
            type="checkbox"
            checked={s.receipts.enabled}
            disabled={locked}
            onChange={(e) => update.mutate({ receipts: { enabled: e.target.checked } })}
            className="accent-primary w-4 h-4"
            aria-label="Receipts by text on"
          />
          <span className="text-sm font-medium text-foreground">{s.receipts.enabled ? "On" : "Off"}</span>
        </label>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1">
          <p className="text-sm text-foreground">
            {s.receipts.enabled
              ? 'Text receipt photos (or PDFs) to your assistant. Add "Jones job", "personal card", "fuel" or "PO-12" if you like. Reply "fix" to change one.'
              : "Receipts by text are off."}
          </p>
          {!data.ownerPhoneOnFile && s.receipts.enabled && <p className="text-xs text-amber-600 dark:text-amber-400">Add and confirm your cell above to text in receipts.</p>}
        </div>

        {data.toFinish && data.toFinish.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Receipts that need a total</p>
            <ul className="space-y-2">
              {data.toFinish.map((item) => (
                <FinishRow
                  key={item.id}
                  item={item}
                  disabled={!canManage || finish.isPending}
                  onFile={(amountCents, taxCents, spentOn) => finish.mutate({ id: item.id, action: "file", amountCents, taxCents, spentOn })}
                  onDiscard={() => finish.mutate({ id: item.id, action: "discard" })}
                />
              ))}
            </ul>
          </div>
        )}

        <fieldset className="space-y-3" disabled={locked}>
          <legend className="text-sm font-medium text-foreground">HST</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted-foreground">
              HST registered?
              <select
                value={registrantValue}
                onChange={(e) => update.mutate({ hst: { registrant: e.target.value === "auto" ? null : e.target.value === "yes" } })}
                className="mt-1 block h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="auto">{data.hstNumberOnFile ? "Yes (HST # on file)" : "No (no HST # on file)"}</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              You file
              <select
                value={s.hst.frequency}
                onChange={(e) => update.mutate({ hst: { frequency: e.target.value as Frequency } })}
                className="mt-1 block h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Once a year</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Fiscal year ends
              <select
                value={s.hst.fiscalYearEndMonth}
                onChange={(e) => update.mutate({ hst: { fiscalYearEndMonth: Number(e.target.value) } })}
                className="mt-1 block h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m.slice(0, 3)} {lastDayOf(i + 1)}
                  </option>
                ))}
              </select>
            </label>
            {s.hst.frequency === "annual" && (
              <label className="text-xs text-muted-foreground">
                The business is
                <select
                  value={s.hst.filer}
                  onChange={(e) => update.mutate({ hst: { filer: e.target.value as Filer } })}
                  className="mt-1 block h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                >
                  <option value="individual">Sole proprietor / partnership</option>
                  <option value="corporation">A corporation</option>
                </select>
              </label>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground grow">
              Accountant's email (the packet goes here, else to you)
              <input
                type="email"
                value={canManage ? emailValue : "(owners and admins only)"}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="books@youraccountant.ca"
                className="mt-1 block h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              />
            </label>
            <button
              type="button"
              disabled={locked || email === null}
              onClick={() => update.mutate({ hst: { accountantEmail: emailValue.trim() || null } })}
              className="h-8 px-3 rounded-md border border-border text-sm disabled:opacity-50"
            >
              Save
            </button>
          </div>
          <label className={cn("flex items-start gap-2.5 p-2.5 rounded-lg border border-border", locked ? "cursor-default" : "cursor-pointer hover:bg-secondary/60")}>
            <input type="checkbox" className="accent-primary mt-0.5 w-4 h-4" checked={s.hst.reminders} onChange={(e) => update.mutate({ hst: { reminders: e.target.checked } })} />
            <span>
              <span className="block text-sm font-medium text-foreground">Text me 10 days before HST is due</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                With what you collected, your ITCs and about what you owe. Reply Y to email the packet.
                {!s.hst.registrant && " Only runs when you're HST registered."}
              </span>
            </span>
          </label>
        </fieldset>

        {data.hst && s.hst.registrant && (
          <div className="rounded-lg border border-border bg-secondary/40 p-3 space-y-2">
            <p className="text-sm font-medium text-foreground">
              {data.hst.period.label} HST ({data.hst.period.range}
              {data.hst.period.toDate ? ", so far" : ""})
            </p>
            <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">101</dt>
              <dd>Sales (before tax)</dd>
              <dd className="text-right tabular-nums">{money(data.hst.salesCents)}</dd>
              <dt className="text-muted-foreground">103</dt>
              <dd>HST collected</dd>
              <dd className="text-right tabular-nums">{money(data.hst.collectedCents)}</dd>
              <dt className="text-muted-foreground">106</dt>
              <dd>Input tax credits</dd>
              <dd className="text-right tabular-nums">{money(data.hst.itcCents)}</dd>
              <dt className="text-muted-foreground">109</dt>
              <dd className="font-medium">Net tax {data.hst.netCents < 0 ? "(refund)" : ""}</dd>
              <dd className="text-right tabular-nums font-medium">{money(data.hst.netCents)}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              Due {day(data.hst.period.paymentDueDate)}
              {data.hst.period.paymentDueDate !== data.hst.period.dueDate ? ` (return by ${day(data.hst.period.dueDate)})` : ""}.
              {data.hst.missingReceipts ? ` ${data.hst.missingReceipts} expense${data.hst.missingReceipts === 1 ? " has" : "s have"} no receipt.` : ""}
              {data.hst.importedExcluded ? ` ${data.hst.importedExcluded} imported invoice${data.hst.importedExcluded === 1 ? " is" : "s are"} left out (your old system reported them).` : ""}
            </p>
            {data.hst.packet.emailedAt && (
              <p className="text-xs text-muted-foreground">
                Packet emailed to {data.hst.packet.emailedTo} on {new Date(data.hst.packet.emailedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}.
              </p>
            )}
            {data.hst.packet.error && !data.hst.packet.emailedAt && <p className="text-xs text-red-600 dark:text-red-400">The last packet email failed. Try again.</p>}
            {!data.hst.period.toDate && (
              <button
                type="button"
                disabled={!canManage || packet.isPending || !data.hst.packet.sendsTo}
                onClick={() => packet.mutate()}
                className="h-8 px-3 rounded-md border border-border text-sm disabled:opacity-50"
              >
                {packet.isPending ? "Sending…" : `Email the packet now${data.hst.packet.sendsTo ? ` to ${data.hst.packet.sendsTo}` : ""}`}
              </button>
            )}
            <p className="text-xs text-muted-foreground">{data.hst.disclaimer} Regular method only.</p>
          </div>
        )}

        <fieldset className="space-y-2" disabled={locked || !s.receipts.enabled}>
          <legend className="text-sm font-medium text-foreground">Reminders about receipts</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary w-4 h-4" checked={s.nudges.weekly} onChange={(e) => update.mutate({ nudges: { weekly: e.target.checked } })} />
            Monday text when expenses are missing a receipt or a job
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary w-4 h-4" checked={s.nudges.tip} onChange={(e) => update.mutate({ nudges: { tip: e.target.checked } })} />
            A one-time tip about texting receipts
          </label>
        </fieldset>

        {data.recent && data.recent.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">Recently texted in</p>
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {data.recent.map((r) => (
                <li key={r.id}>
                  {new Date(r.createdAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })} · {r.vendor ?? "Receipt"}
                  {r.amountCents ? ` ${money(r.amountCents)}` : ""}
                  {r.poReference ? ` · ${r.poReference}` : ""} · {STATUS_WORD[r.status] ?? r.status}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!s.receipts.enabled && !data.defaultEnabled && <p className="text-xs text-muted-foreground">Off for this business. Turn it on to text in receipts.</p>}
        {!canManage && <p className="text-xs text-muted-foreground">Only owners and admins can change this or see the HST figures.</p>}
      </div>
    </AiFrontDeskSectionCard>
  );
}
