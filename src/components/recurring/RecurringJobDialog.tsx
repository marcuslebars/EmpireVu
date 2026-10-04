import { useMemo, useState } from "react";
import { Check, Loader2, Plus, Repeat, Trash2 } from "lucide-react";

import { AccountDialogShell } from "@/components/invoices/AccountDialogShell";
import {
  centsToInput,
  errorMessage,
  inputCls,
  labelCls,
  parseDollarsToCents,
  primaryBtnCls,
  secondaryBtnCls,
  sectionLabelCls,
  selectCls,
  todayYmd,
} from "@/components/invoices/invoice-ui";
import { QuoteCustomerField } from "@/components/quotes/QuoteCustomerField";
import { toast } from "@/components/ui/sonner";
import { useCompanies, useOrgMembers } from "@/lib/api-hooks";
import { useChecklistTemplates } from "@/lib/job-hooks";
import { formatCents } from "@/lib/invoices-api";
import { describeRule, occurrencesBetween, addDaysYmd, type RecurrenceRule } from "@/lib/recurrence";
import type { Frequency, RecurringJob, RecurringJobPayload } from "@/lib/recurring-api";
import { useSaveRecurringJob } from "@/lib/recurring-hooks";
import { cn } from "@/lib/utils";

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DURATIONS = [30, 45, 60, 90, 120, 180, 240, 480];

type EndMode = "never" | "on" | "after";

interface LineDraft {
  label: string;
  quantity: string;
  price: string;
}

function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function prettyDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

/** Create or edit a recurring job. Saving lays out the next ~60 days of visits. */
export function RecurringJobDialog({
  orgId,
  defaultCompanyId,
  job,
  onClose,
}: {
  orgId: string;
  defaultCompanyId: string | null;
  job: RecurringJob | null;
  onClose: () => void;
}) {
  const { data: companies = [] } = useCompanies(orgId);
  const { data: members = [] } = useOrgMembers(orgId);
  const save = useSaveRecurringJob(orgId);

  const [companyId, setCompanyId] = useState(job?.companyId ?? defaultCompanyId ?? companies[0]?.id ?? "");
  const { data: templates = [] } = useChecklistTemplates(orgId, companyId || null);
  const [contactId, setContactId] = useState<string | null>(job?.contactId ?? null);
  const [contactLabel, setContactLabel] = useState(job?.contactName ?? "");
  const [title, setTitle] = useState(job?.title ?? "");
  const [frequency, setFrequency] = useState<Frequency>(job?.frequency ?? "weekly");
  const [interval, setIntervalCount] = useState(job?.interval ?? 1);
  const [startDate, setStartDate] = useState(job?.startDate ?? todayYmd());
  const [weekdays, setWeekdays] = useState<number[]>(job?.weekdays.length ? job.weekdays : [weekdayOf(job?.startDate ?? todayYmd())]);
  const [timeOfDay, setTimeOfDay] = useState(job?.timeOfDay ?? "09:00");
  const [duration, setDuration] = useState(job?.durationMinutes ?? 60);
  const [endMode, setEndMode] = useState<EndMode>(job?.endsOn ? "on" : job?.maxOccurrences ? "after" : "never");
  const [endsOn, setEndsOn] = useState(job?.endsOn ?? "");
  const [maxOcc, setMaxOcc] = useState(String(job?.maxOccurrences ?? 10));
  const [location, setLocation] = useState(job?.location ?? "");
  const [notes, setNotes] = useState(job?.description ?? "");
  const [crew, setCrew] = useState<string[]>(job?.crewProfileIds ?? []);
  const [templateId, setTemplateId] = useState(job?.checklistTemplateId ?? "");
  const [lines, setLines] = useState<LineDraft[]>(
    job?.lineItems.length
      ? job.lineItems.map((l) => ({ label: l.label, quantity: String(l.quantity), price: centsToInput(l.unitPriceCents) }))
      : [{ label: "", quantity: "1", price: "" }],
  );
  const [error, setError] = useState<string | null>(null);

  const rule: RecurrenceRule = {
    frequency,
    interval,
    weekdays: frequency === "weekly" ? weekdays : [],
    startDate,
    endsOn: endMode === "on" && endsOn ? endsOn : null,
    maxOccurrences: endMode === "after" ? Number(maxOcc) || null : null,
  };
  const preview = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return [];
    const from = startDate > todayYmd() ? startDate : todayYmd();
    return occurrencesBetween(rule, from, addDaysYmd(from, 3700), 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frequency, interval, weekdays.join(","), startDate, endMode, endsOn, maxOcc]);

  const parsedLines = lines
    .filter((l) => l.label.trim() || l.price.trim())
    .map((l) => ({ label: l.label.trim(), quantity: Number(l.quantity) || 0, unitPriceCents: parseDollarsToCents(l.price) }));
  const total = parsedLines.reduce((s, l) => s + Math.round(l.quantity * (l.unitPriceCents ?? 0)), 0);

  const onStartChange = (v: string) => {
    setStartDate(v);
    // Keep "weekly on <day>" in step with the start date when only one day is picked.
    if (frequency === "weekly" && weekdays.length <= 1 && /^\d{4}-\d{2}-\d{2}$/.test(v)) setWeekdays([weekdayOf(v)]);
  };

  const validate = (): string | null => {
    if (!companyId) return "Pick a company.";
    if (!title.trim()) return "Give the job a name.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return "Pick a start date.";
    if (frequency === "weekly" && weekdays.length === 0) return "Pick at least one day of the week.";
    if (endMode === "on" && (!endsOn || endsOn < startDate)) return "The end date must be on or after the start date.";
    if (endMode === "after" && !(Number(maxOcc) >= 1)) return "Enter how many visits.";
    for (const l of parsedLines) {
      if (!l.label) return "Every price line needs a description.";
      if (!(l.quantity > 0)) return `"${l.label}": quantity must be more than 0.`;
      if (l.unitPriceCents === null) return `"${l.label}": enter a price like 95 or 95.00.`;
    }
    return null;
  };

  const onSave = async () => {
    const problem = validate();
    if (problem) return setError(problem);
    setError(null);
    const payload: RecurringJobPayload = {
      companyId,
      contactId,
      title: title.trim(),
      description: notes.trim() || null,
      location: location.trim() || null,
      durationMinutes: duration,
      frequency,
      interval,
      weekdays: frequency === "weekly" ? weekdays : [],
      startDate,
      timeOfDay,
      endsOn: endMode === "on" ? endsOn : null,
      maxOccurrences: endMode === "after" ? Number(maxOcc) : null,
      crewProfileIds: crew,
      checklistTemplateId: templateId || null,
      lineItems: parsedLines.map((l) => ({ label: l.label, quantity: l.quantity, unitPriceCents: l.unitPriceCents ?? 0 })),
    };
    try {
      const res = await save.mutateAsync({ id: job?.id, payload });
      toast.success(
        job
          ? `Saved — ${res.visitsCreated} upcoming visit${res.visitsCreated === 1 ? "" : "s"} updated`
          : `${res.visitsCreated} visit${res.visitsCreated === 1 ? "" : "s"} added to the calendar`,
      );
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AccountDialogShell
      title={job ? "Edit recurring job" : "New recurring job"}
      description={job ? "Upcoming visits nobody has touched are updated. Visits you moved by hand stay put." : "Repeat work on a schedule — visits appear on the calendar and in My Jobs."}
      icon={<Repeat className="w-4 h-4" />}
      size="lg"
      onClose={onClose}
    >
      <div className="px-6 py-5 space-y-5">
        {/* What + who */}
        <div className="space-y-3">
          {companies.length > 1 && !job && (
            <div>
              <label className={labelCls}>Company</label>
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={selectCls}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="rj-title">
              Job
            </label>
            <input id="rj-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Weekly pool clean" className={inputCls} />
          </div>
          {companyId && (
            <QuoteCustomerField
              orgId={orgId}
              companyId={companyId}
              contactId={contactId}
              contactLabel={contactLabel}
              onChange={(id, label) => {
                setContactId(id);
                setContactLabel(label);
              }}
            />
          )}
        </div>

        {/* When */}
        <div className="space-y-3">
          <p className={sectionLabelCls}>Schedule</p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <span>Every</span>
            <input
              aria-label="Repeat every"
              type="number"
              min={1}
              max={52}
              value={interval}
              onChange={(e) => setIntervalCount(Math.min(52, Math.max(1, Number(e.target.value) || 1)))}
              className={cn(inputCls, "w-16 text-center")}
            />
            <select aria-label="Repeat unit" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)} className={cn(selectCls, "w-auto")}>
              <option value="weekly">{interval === 1 ? "week" : "weeks"}</option>
              <option value="monthly">{interval === 1 ? "month" : "months"}</option>
              <option value="yearly">{interval === 1 ? "year" : "years"}</option>
            </select>
          </div>
          {frequency === "weekly" && (
            <div className="flex gap-1.5" role="group" aria-label="Days of the week">
              {DAYS.map((d, i) => {
                const on = weekdays.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={on}
                    aria-label={DAY_NAMES[i]}
                    onClick={() => setWeekdays((w) => (on ? w.filter((x) => x !== i) : [...w, i].sort()))}
                    className={cn(
                      "w-9 h-9 rounded-full text-xs font-semibold border transition-colors",
                      on ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-muted-foreground border-border hover:text-foreground",
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls} htmlFor="rj-start">
                Starts
              </label>
              <input id="rj-start" type="date" value={startDate} onChange={(e) => onStartChange(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="rj-time">
                Time
              </label>
              <input id="rj-time" type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="rj-dur">
                Length
              </label>
              <select id="rj-dur" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={selectCls}>
                {(DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b)).map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : `${m / 60} h`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground text-xs font-medium">Ends</span>
            <select aria-label="Ends" value={endMode} onChange={(e) => setEndMode(e.target.value as EndMode)} className={cn(selectCls, "w-auto")}>
              <option value="never">Never</option>
              <option value="on">On a date</option>
              <option value="after">After a number of visits</option>
            </select>
            {endMode === "on" && <input aria-label="End date" type="date" value={endsOn} min={startDate} onChange={(e) => setEndsOn(e.target.value)} className={cn(inputCls, "w-auto")} />}
            {endMode === "after" && (
              <>
                <input aria-label="Number of visits" type="number" min={1} max={1000} value={maxOcc} onChange={(e) => setMaxOcc(e.target.value)} className={cn(inputCls, "w-20")} />
                <span className="text-xs text-muted-foreground">visits</span>
              </>
            )}
          </div>
          <div className="rounded-lg bg-secondary/50 border border-border px-3 py-2 text-xs">
            <p className="font-medium text-foreground">{describeRule(rule)}</p>
            <p className="text-muted-foreground mt-0.5">
              {preview.length ? `Next: ${preview.map(prettyDate).join(" · ")}` : "No visits — check the dates."}
            </p>
          </div>
        </div>

        {/* Where + crew */}
        <div className="space-y-3">
          <p className={sectionLabelCls}>On each visit</p>
          <div>
            <label className={labelCls} htmlFor="rj-loc">
              Where
            </label>
            <input id="rj-loc" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} placeholder="Address or site (optional)" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Crew</label>
            {members.length === 0 ? (
              <p className="text-xs text-muted-foreground">Invite your team in Settings → Members to assign crew.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {members.map((m) => {
                  const on = crew.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCrew((c) => (on ? c.filter((x) => x !== m.id) : [...c, m.id]))}
                      className={cn(
                        "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                        on ? "bg-primary/10 border-primary/40 text-foreground" : "bg-secondary border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {on && <Check className="w-3 h-3 text-primary" />}
                      {m.name || m.email}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <label className={labelCls} htmlFor="rj-tpl">
              Checklist
            </label>
            <select id="rj-tpl" value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={selectCls}>
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.items.length} items)
                </option>
              ))}
            </select>
            {templates.length === 0 && <p className="text-[11px] text-muted-foreground mt-1">Save checklists in Settings → Job checklists.</p>}
          </div>
          <div>
            <label className={labelCls} htmlFor="rj-notes">
              Notes for the crew
            </label>
            <textarea id="rj-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} className={cn(inputCls, "resize-y")} />
          </div>
        </div>

        {/* Price */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className={sectionLabelCls}>Price per visit</p>
            {total > 0 && <span className="text-sm font-semibold text-foreground tabular-nums">{formatCents(total)} + tax</span>}
          </div>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <input
                aria-label="Line description"
                value={l.label}
                onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                placeholder="e.g. Pool clean"
                className={cn(inputCls, "flex-1 min-w-0")}
              />
              <input
                aria-label="Quantity"
                value={l.quantity}
                onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                inputMode="decimal"
                className={cn(inputCls, "w-14 text-center")}
              />
              <input
                aria-label="Price"
                value={l.price}
                onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
                inputMode="decimal"
                placeholder="$0.00"
                className={cn(inputCls, "w-24 text-right")}
              />
              <button
                type="button"
                aria-label="Remove line"
                onClick={() => setLines((ls) => (ls.length === 1 ? [{ label: "", quantity: "1", price: "" }] : ls.filter((_, j) => j !== i)))}
                className="px-2 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setLines((ls) => [...ls, { label: "", quantity: "1", price: "" }])} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            <Plus className="w-3 h-3" /> Add a line
          </button>
          <p className="text-[11px] text-muted-foreground">
            Used when a visit is invoiced (Settings → Invoices → "When a job is marked done"). Leave blank to price each visit by hand.
          </p>
        </div>

        {error && <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
        <button type="button" onClick={onClose} className={secondaryBtnCls}>
          Cancel
        </button>
        <button type="button" onClick={() => void onSave()} disabled={save.isPending} className={primaryBtnCls}>
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {job ? "Save changes" : "Create & schedule"}
        </button>
      </div>
    </AccountDialogShell>
  );
}
