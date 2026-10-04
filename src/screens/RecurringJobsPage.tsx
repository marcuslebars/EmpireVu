import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarClock, MapPin, MoreHorizontal, Pause, Pencil, Play, Plus, Repeat, Square, User, Users } from "lucide-react";

import { RecurringJobDialog } from "@/components/recurring/RecurringJobDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SkeletonCard } from "@/components/ui/StateViews";
import { toast } from "@/components/ui/sonner";
import { formatCents } from "@/lib/invoices-api";
import { useOrg } from "@/lib/org-context";
import type { RecurringJob } from "@/lib/recurring-api";
import { useRecurringJobs, useSetRecurringStatus } from "@/lib/recurring-hooks";
import { cn } from "@/lib/utils";

function nextLabel(iso: string | null): string {
  if (!iso) return "No upcoming visits";
  const d = new Date(iso);
  return `Next: ${d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })} · ${d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`;
}

/** "08:30" → "8:30 a.m." */
function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString("en-CA", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
}

const STATUS_TONE: Record<RecurringJob["status"], string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  paused: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  ended: "bg-secondary text-muted-foreground border-border",
};

function SeriesCard({
  job,
  onEdit,
  onStatus,
}: {
  job: RecurringJob;
  onEdit: () => void;
  onStatus: (status: RecurringJob["status"]) => void;
}) {
  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", job.status === "ended" && "opacity-70")}>
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={onEdit} disabled={job.status === "ended"} className="min-w-0 text-left space-y-1 disabled:cursor-default">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-foreground">{job.title}</p>
            <span className={cn("text-[11px] font-semibold px-2 py-0.5 rounded-full border capitalize", STATUS_TONE[job.status])}>{job.status}</span>
          </div>
          <p className="text-xs text-foreground/80 flex items-center gap-1.5">
            <Repeat className="w-3 h-3 text-muted-foreground" />
            {job.ruleText} at {clockLabel(job.timeOfDay)}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {job.contactName && (
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" /> {job.contactName}
              </span>
            )}
            {job.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3 h-3" /> {job.location}
              </span>
            )}
            <span className={cn("flex items-center gap-1", job.crewNames.length === 0 && job.status === "active" && "text-amber-600 dark:text-amber-400")}>
              <Users className="w-3 h-3" /> {job.crewNames.length ? job.crewNames.join(", ") : "No crew"}
            </span>
          </div>
          {job.status === "active" && (
            <p className="text-xs text-foreground flex items-center gap-1.5 pt-0.5">
              <CalendarClock className="w-3 h-3 text-muted-foreground" />
              {nextLabel(job.nextVisitAt)}
              <span className="text-muted-foreground">· {job.upcomingCount} on the calendar · {job.completedCount} done</span>
            </p>
          )}
        </button>
        <div className="flex items-start gap-2 shrink-0">
          {job.priceCents > 0 && <span className="text-sm font-semibold tabular-nums text-foreground">{formatCents(job.priceCents)}</span>}
          {job.status !== "ended" && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`Actions for ${job.title}`} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary">
                <MoreHorizontal className="w-4 h-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
                </DropdownMenuItem>
                {job.status === "active" ? (
                  <DropdownMenuItem onClick={() => onStatus("paused")}>
                    <Pause className="w-3.5 h-3.5 mr-2" /> Pause
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => onStatus("active")}>
                    <Play className="w-3.5 h-3.5 mr-2" /> Resume
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onStatus("ended")} className="text-destructive focus:text-destructive">
                  <Square className="w-3.5 h-3.5 mr-2" /> End
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
}

/** Recurring jobs: repeat work that fills the calendar by itself. */
export default function RecurringJobsPage() {
  const { organizationId, companyId } = useOrg();
  const { data: jobs, isLoading, isError, refetch } = useRecurringJobs(organizationId, companyId);
  const setStatus = useSetRecurringStatus(organizationId);
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState<RecurringJob | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ job: RecurringJob; status: "paused" | "ended" } | null>(null);

  // /recurring?open=<id> (from a job sheet) opens that series.
  useEffect(() => {
    const open = searchParams.get("open");
    if (open && jobs) {
      const job = jobs.find((j) => j.id === open);
      if (job) setEditing(job);
      const next = new URLSearchParams(searchParams);
      next.delete("open");
      setSearchParams(next, { replace: true });
    }
  }, [jobs, searchParams, setSearchParams]);

  const apply = async (job: RecurringJob, status: RecurringJob["status"]) => {
    try {
      const res = await setStatus.mutateAsync({ id: job.id, status });
      if (status === "active") toast.success(`Resumed — ${res.visitsCreated} visit${res.visitsCreated === 1 ? "" : "s"} back on the calendar`);
      else toast.success(`${status === "paused" ? "Paused" : "Ended"} — ${res.visitsRemoved ?? 0} upcoming visit${res.visitsRemoved === 1 ? "" : "s"} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update.");
    }
  };

  const active = (jobs ?? []).filter((j) => j.status === "active");
  const monthly = active.reduce((sum, j) => {
    // Rough visits per month, for the "recurring revenue" headline.
    const perMonth = j.frequency === "weekly" ? (52 / 12 / j.interval) * Math.max(1, j.weekdays.length) : j.frequency === "monthly" ? 1 / j.interval : 1 / (12 * j.interval);
    return sum + j.priceCents * perMonth;
  }, 0);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Recurring jobs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Repeat work that schedules itself — weekly, monthly or yearly</p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="self-start sm:self-auto flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[hsl(var(--accent-blue))] text-white hover:bg-[hsl(var(--accent-blue))]/90 transition-all shadow-md shadow-blue-500/20 active:scale-[0.97]"
        >
          <Plus className="w-4 h-4" />
          New recurring job
        </button>
      </div>

      {active.length > 0 && (
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Active</p>
            <p className="text-2xl font-bold tabular-nums text-foreground mt-1">{active.length}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Per month</p>
            <p className="text-2xl font-bold tabular-nums text-foreground mt-1">{monthly > 0 ? `~${formatCents(Math.round(monthly / 100) * 100)}` : "—"}</p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center space-y-2">
          <p className="text-sm text-foreground">Couldn't load recurring jobs.</p>
          <button onClick={() => void refetch()} className="text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : (jobs ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center space-y-2">
          <Repeat className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No recurring jobs yet</p>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            Set up work that repeats — a weekly clean, a monthly service, a yearly inspection. Visits land on the calendar with the crew, checklist and price
            already filled in.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {(jobs ?? []).map((j) => (
            <SeriesCard
              key={j.id}
              job={j}
              onEdit={() => setEditing(j)}
              onStatus={(status) => (status === "active" ? void apply(j, status) : setConfirm({ job: j, status: status as "paused" | "ended" }))}
            />
          ))}
        </div>
      )}

      {editing && (
        <RecurringJobDialog
          key={editing === "new" ? "new" : editing.id}
          orgId={organizationId}
          defaultCompanyId={companyId ?? null}
          job={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.status === "ended" ? "End this recurring job?" : "Pause this recurring job?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.job.upcomingCount ?? 0} upcoming visit{confirm?.job.upcomingCount === 1 ? "" : "s"} will come off the calendar (visits already started,
              moved by hand or done stay).{" "}
              {confirm?.status === "ended" ? "This can't be resumed." : "You can resume it any time."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) void apply(confirm.job, confirm.status);
                setConfirm(null);
              }}
            >
              {confirm?.status === "ended" ? "End it" : "Pause"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
