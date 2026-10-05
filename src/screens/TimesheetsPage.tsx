import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Download, Loader2, Pencil, Plus, Square, Trash2 } from "lucide-react";

import { AccountDialogShell } from "@/components/invoices/AccountDialogShell";
import { centsToInput, errorMessage, inputCls, labelCls, parseDollarsToCents, primaryBtnCls, secondaryBtnCls, selectCls } from "@/components/invoices/invoice-ui";
import { SkeletonCard } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { useOrgMembers } from "@/lib/api-hooks";
import { useAuth } from "@/lib/auth-context";
import { formatCents } from "@/lib/invoices-api";
import { useJobs } from "@/lib/job-hooks";
import { hm } from "@/lib/jobs-format";
import { useOrg } from "@/lib/org-context";
import { downloadTimesheetCsv, type PayRate, type TimeEntry } from "@/lib/time-api";
import { useClockIn, useClockOut, useDeleteEntry, useMyClock, useProfitReport, useRates, useSaveEntry, useSetRate, useTimesheet } from "@/lib/time-hooks";
import { cn } from "@/lib/utils";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Toronto";

function ymdLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}
function dayHeading(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" });
}
function toLocalInput(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: ymdLocal(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

// ── Clock bar ────────────────────────────────────────────────────────────────

function ClockBar({ orgId }: { orgId: string }) {
  const { data: running, isLoading } = useMyClock(orgId);
  const clockIn = useClockIn(orgId);
  const clockOut = useClockOut(orgId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [running]);
  if (isLoading) return null;
  const mins = running ? Math.max(0, Math.floor((now - Date.parse(running.startedAt)) / 60_000)) : 0;
  const act = async () => {
    try {
      if (running) await clockOut.mutateAsync();
      else await clockIn.mutateAsync(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className={cn("flex items-center justify-between gap-3 rounded-xl border p-4", running ? "border-emerald-500/30 bg-emerald-500/5" : "border-border bg-card")}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0", running ? "bg-emerald-500/15 text-emerald-600" : "bg-secondary text-muted-foreground")}>
          <Clock className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{running ? `Clocked in · ${hm(mins)}` : "You're not clocked in"}</p>
          <p className="text-xs text-muted-foreground truncate">
            {running ? `${running.jobTitle ?? "General time"} · since ${clock(running.startedAt)}` : "Clock in from a job (Start job does it for you) or here for general time."}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void act()}
        disabled={clockIn.isPending || clockOut.isPending}
        className={cn(
          "shrink-0 flex items-center gap-1.5 px-4 h-10 rounded-lg text-sm font-semibold disabled:opacity-60",
          running ? "bg-destructive/10 text-destructive border border-destructive/30" : "bg-primary text-primary-foreground",
        )}
      >
        {clockIn.isPending || clockOut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : running ? <Square className="w-3.5 h-3.5" /> : <Clock className="w-4 h-4" />}
        {running ? "Clock out" : "Clock in"}
      </button>
    </div>
  );
}

// ── Entry editor ─────────────────────────────────────────────────────────────

function EntryDialog({
  orgId,
  entry,
  manager,
  me,
  weekFrom,
  onClose,
}: {
  orgId: string;
  entry: TimeEntry | null;
  manager: boolean;
  me: string | null;
  weekFrom: Date;
  onClose: () => void;
}) {
  const save = useSaveEntry(orgId);
  const { data: members = [] } = useOrgMembers(orgId);
  const { data: jobs = [] } = useJobs(orgId, {
    scope: manager ? "all" : "mine",
    from: addDays(weekFrom, -14).toISOString(),
    to: addDays(weekFrom, 14).toISOString(),
    includeDone: true,
  });
  const start = entry ? toLocalInput(entry.startedAt) : { date: ymdLocal(new Date()), time: "08:00" };
  const end = entry?.endedAt ? toLocalInput(entry.endedAt) : { date: start.date, time: entry ? "" : "16:00" };
  const [profileId, setProfileId] = useState(entry?.profileId ?? me ?? "");
  const [bookingId, setBookingId] = useState(entry?.bookingId ?? "");
  const [date, setDate] = useState(start.date);
  const [from, setFrom] = useState(start.time);
  const [to, setTo] = useState(end.time);
  const [brk, setBrk] = useState(String(entry?.breakMinutes ?? 0));
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  const onSave = async () => {
    if (!from || !to) return setError("Enter a start and an end time.");
    const s = new Date(`${date}T${from}`);
    let e = new Date(`${date}T${to}`);
    if (e <= s) e = addDays(e, 1); // past midnight
    try {
      await save.mutateAsync({
        id: entry?.id,
        payload: {
          ...(entry ? {} : { profileId: profileId || undefined }),
          bookingId: bookingId || null,
          startedAt: s.toISOString(),
          endedAt: e.toISOString(),
          breakMinutes: Math.max(0, Math.round(Number(brk) || 0)),
          notes: notes.trim() || null,
        },
      });
      toast.success(entry ? "Time updated" : "Time added");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AccountDialogShell title={entry ? "Edit time" : "Add time"} icon={<Clock className="w-4 h-4" />} onClose={onClose}>
      <div className="px-6 py-5 space-y-3">
        {manager && !entry && (
          <div>
            <label className={labelCls}>Person</label>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className={selectCls}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.email}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls}>Job</label>
          <select value={bookingId} onChange={(e) => setBookingId(e.target.value)} className={selectCls}>
            <option value="">General time (no job)</option>
            {entry?.bookingId && !jobs.some((j) => j.id === entry.bookingId) && <option value={entry.bookingId}>{entry.jobTitle ?? "This job"}</option>}
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {new Date(j.scheduledFor).toLocaleDateString("en-CA", { month: "short", day: "numeric" })} · {j.title}
                {j.contactName ? ` — ${j.contactName}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Start</label>
            <input aria-label="Start" type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input aria-label="End" type="time" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Break (min)</label>
            <input type="number" min={0} max={600} value={brk} onChange={(e) => setBrk(e.target.value)} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className={inputCls} />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
        <button type="button" onClick={onClose} className={secondaryBtnCls}>
          Cancel
        </button>
        <button type="button" onClick={() => void onSave()} disabled={save.isPending} className={primaryBtnCls}>
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
        </button>
      </div>
    </AccountDialogShell>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function HoursTab({ orgId, manager, me }: { orgId: string; manager: boolean; me: string | null }) {
  const [week, setWeek] = useState(() => mondayOf(new Date()));
  const [person, setPerson] = useState("");
  const [editing, setEditing] = useState<TimeEntry | "new" | null>(null);
  const { data: members = [] } = useOrgMembers(orgId);
  const del = useDeleteEntry(orgId);
  const range = useMemo(() => ({ from: week.toISOString(), to: addDays(week, 7).toISOString(), profileId: person || null }), [week, person]);
  const { data, isLoading } = useTimesheet(orgId, range);
  const entries = useMemo(() => data?.entries ?? [], [data]);

  const byDay = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const k = ymdLocal(new Date(e.startedAt));
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);
  const totalMin = entries.reduce((s, e) => s + e.minutes, 0);
  const label = `${week.toLocaleDateString("en-CA", { month: "short", day: "numeric" })} – ${addDays(week, 6).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`;

  const exportCsv = async () => {
    try {
      await downloadTimesheetCsv(orgId, range.from, range.to, TZ, `timesheet-${ymdLocal(week)}.csv`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))} className="w-8 h-8 rounded-lg border border-border bg-secondary flex items-center justify-center">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-foreground px-2 min-w-[9.5rem] text-center">{label}</span>
          <button aria-label="Next week" onClick={() => setWeek(addDays(week, 7))} className="w-8 h-8 rounded-lg border border-border bg-secondary flex items-center justify-center">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          {manager && (
            <select aria-label="Person" value={person} onChange={(e) => setPerson(e.target.value)} className={cn(selectCls, "w-auto py-1.5")}>
              <option value="">Everyone</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.email}
                </option>
              ))}
            </select>
          )}
          <button onClick={() => void exportCsv()} className={cn(secondaryBtnCls, "py-1.5")}>
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button onClick={() => setEditing("new")} className={cn(primaryBtnCls, "py-1.5")}>
            <Plus className="w-3.5 h-3.5" /> Add time
          </button>
        </div>
      </div>

      {data && data.summary.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {data.summary.map((p) => (
            <div key={p.profileId} className="rounded-xl border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground truncate">{p.name}</p>
              <p className="text-lg font-bold tabular-nums text-foreground">{hm(p.minutes)}</p>
              {data.canSeeCosts && <p className="text-[11px] text-muted-foreground">{p.costCents === null ? "no rate" : formatCents(p.costCents)}</p>}
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <SkeletonCard rows={3} />
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No time logged this week.</div>
      ) : (
        <div className="space-y-4">
          {byDay.map(([day, list]) => (
            <section key={day} className="space-y-1.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                {dayHeading(day)} <span className="font-medium normal-case tracking-normal">· {hm(list.reduce((s, e) => s + e.minutes, 0))}</span>
              </h3>
              <ul className="rounded-xl border border-border bg-card divide-y divide-border">
                {list.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">
                        {manager && <span className="font-medium">{e.personName} · </span>}
                        {e.jobTitle ?? <span className="text-muted-foreground">General time</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {clock(e.startedAt)} – {e.endedAt ? clock(e.endedAt) : "running"}
                        {e.breakMinutes > 0 && ` · ${e.breakMinutes}m break`}
                        {e.source === "manual" && " · added by hand"}
                        {e.notes && ` · ${e.notes}`}
                      </p>
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-foreground">{hm(e.minutes)}</span>
                    <button aria-label="Edit" onClick={() => setEditing(e)} className="p-1.5 text-muted-foreground hover:text-foreground">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      aria-label="Delete"
                      onClick={() => del.mutate(e.id, { onSuccess: () => toast.success("Entry deleted"), onError: (err) => toast.error(errorMessage(err)) })}
                      className="p-1.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="text-sm text-right text-foreground">
            Week total <span className="font-bold tabular-nums">{hm(totalMin)}</span>
          </p>
        </div>
      )}

      {editing && (
        <EntryDialog orgId={orgId} entry={editing === "new" ? null : editing} manager={manager} me={me} weekFrom={week} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function ProfitTab({ orgId, companyId }: { orgId: string; companyId: string | null }) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const range = useMemo(
    () => ({ from: month.toISOString(), to: new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString(), companyId }),
    [month, companyId],
  );
  const { data, isLoading } = useProfitReport(orgId, range, true);
  const label = month.toLocaleDateString("en-CA", { month: "long", year: "numeric" });
  const margin = data && data.totals.revenueCents > 0 ? Math.round((data.totals.profitCents / data.totals.revenueCents) * 1000) / 10 : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <button aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="w-8 h-8 rounded-lg border border-border bg-secondary flex items-center justify-center">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-semibold text-foreground px-2 min-w-[8rem] text-center">{label}</span>
        <button aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="w-8 h-8 rounded-lg border border-border bg-secondary flex items-center justify-center">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      {isLoading || !data ? (
        <SkeletonCard rows={3} />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              ["Revenue", formatCents(data.totals.revenueCents)],
              ["Costs", formatCents(data.totals.costCents)],
              ["Profit", formatCents(data.totals.profitCents)],
              ["Margin", margin === null ? "—" : `${margin}%`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{k}</p>
                <p className={cn("text-lg font-bold tabular-nums", k === "Profit" && data.totals.profitCents < 0 ? "text-destructive" : "text-foreground")}>{v}</p>
              </div>
            ))}
          </div>
          {data.missingRateNames.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> No pay rate for {data.missingRateNames.join(", ")} — their hours count as $0. Set them under Pay rates.
            </p>
          )}
          {data.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No finished jobs this month.</div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left font-medium px-4 py-2">Job</th>
                    <th className="text-right font-medium px-3 py-2">Revenue</th>
                    <th className="text-right font-medium px-3 py-2">Labour</th>
                    <th className="text-right font-medium px-3 py-2">Materials & expenses</th>
                    <th className="text-right font-medium px-4 py-2">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.rows.map((r) => (
                    <tr key={r.bookingId}>
                      <td className="px-4 py-2.5">
                        <a href={`/jobs/${r.bookingId}`} className="text-foreground hover:underline">
                          {r.title}
                        </a>
                        <p className="text-xs text-muted-foreground">
                          {new Date(r.scheduledFor).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
                          {r.contactName ? ` · ${r.contactName}` : ""}
                          {r.revenueSource === "estimate" && " · not invoiced yet"}
                          {r.revenueSource === "none" && " · no price"}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCents(r.revenueCents)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatCents(r.labourCents)}
                        <span className="block text-[11px]">{hm(r.labourMinutes)}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{formatCents(r.materialsCents + (r.expensesCents ?? 0))}</td>
                      <td className={cn("px-4 py-2.5 text-right tabular-nums font-semibold", r.profitCents < 0 ? "text-destructive" : "text-foreground")}>
                        {formatCents(r.profitCents)}
                        {r.marginPct !== null && <span className="block text-[11px] font-normal text-muted-foreground">{r.marginPct}%</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RateRow({ orgId, rate }: { orgId: string; rate: PayRate }) {
  const set = useSetRate(orgId);
  const [value, setValue] = useState(rate.hourlyCostCents === null ? "" : centsToInput(rate.hourlyCostCents));
  const commit = async () => {
    const trimmed = value.trim();
    const cents = trimmed === "" ? null : parseDollarsToCents(trimmed);
    if (trimmed !== "" && (cents === null || cents < 0)) return toast.error("Enter an hourly amount like 28 or 28.50.");
    if (cents === rate.hourlyCostCents) return;
    try {
      await set.mutateAsync({ profileId: rate.profileId, hourlyCostCents: cents });
      toast.success(`Saved ${rate.name}'s rate`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm text-foreground truncate">{rate.name}</p>
        <p className="text-xs text-muted-foreground truncate capitalize">{rate.role}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          aria-label={`Hourly cost for ${rate.name}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          inputMode="decimal"
          placeholder="—"
          className={cn(inputCls, "w-24 text-right")}
        />
        <span className="text-xs text-muted-foreground">/h</span>
        {set.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
      </div>
    </li>
  );
}

function RatesTab({ orgId }: { orgId: string }) {
  const { data: rates, isLoading } = useRates(orgId, true);
  return (
    <div className="space-y-3 max-w-xl">
      <p className="text-sm text-muted-foreground">
        What an hour of each person costs you (wage plus burden). Used for job profit — only owners and admins can see these.
      </p>
      {isLoading || !rates ? (
        <SkeletonCard rows={3} />
      ) : (
        <ul className="rounded-xl border border-border bg-card divide-y divide-border">
          {rates.map((r) => (
            <RateRow key={r.profileId} orgId={orgId} rate={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

type Tab = "hours" | "profit" | "rates";

export default function TimesheetsPage() {
  const { organizationId, companyId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const manager = role === "owner" || role === "admin";
  const me = session?.user?.id ?? null;
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = manager && (requested === "profit" || requested === "rates") ? requested : "hours";
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === "hours") next.delete("tab");
    else next.set("tab", t);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Timesheets</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{manager ? "Hours, labour cost and profit per job" : "Your hours"}</p>
      </div>
      <ClockBar orgId={organizationId} />
      {manager && (
        <div role="tablist" className="flex gap-1 border-b border-border">
          {(
            [
              ["hours", "Hours"],
              ["profit", "Job profit"],
              ["rates", "Pay rates"],
            ] as Array<[Tab, string]>
          ).map(([t, l]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {l}
            </button>
          ))}
        </div>
      )}
      {tab === "hours" && <HoursTab orgId={organizationId} manager={manager} me={me} />}
      {tab === "profit" && <ProfitTab orgId={organizationId} companyId={companyId ?? null} />}
      {tab === "rates" && <RatesTab orgId={organizationId} />}
    </div>
  );
}
