import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ChevronRight, ClipboardCheck, ListChecks, MapPin, RefreshCw } from "lucide-react";

import { JobSheetView, StageBadge } from "@/components/jobs/JobSheetView";
import { SkeletonCard } from "@/components/ui/StateViews";
import { useAuth } from "@/lib/auth-context";
import { useJob, useJobs } from "@/lib/job-hooks";
import type { JobSummary } from "@/lib/jobs-api";
import { groupJobsByDay, initials, timeLabel } from "@/lib/jobs-format";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";

function JobCard({ job, showCrew }: { job: JobSummary; showCrew: boolean }) {
  const navigate = useNavigate();
  const noCrew = job.crew.length === 0;
  return (
    <button
      type="button"
      onClick={() => navigate(`/jobs/${job.id}`)}
      className={cn(
        "w-full text-left rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 active:scale-[0.995]",
        job.stage === "done" ? "border-border opacity-70" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="w-[4.5rem] shrink-0">
          <p className="text-sm font-bold tabular-nums text-foreground whitespace-nowrap">{timeLabel(job.scheduledFor, job.timeZone)}</p>
          <p className="text-[11px] text-muted-foreground">{job.durationMinutes} min</p>
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-foreground leading-snug">{job.title}</p>
            <StageBadge stage={job.stage} />
          </div>
          {job.contactName && <p className="text-xs text-muted-foreground truncate">{job.contactName}</p>}
          {job.location && (
            <p className="text-xs text-foreground/80 flex items-center gap-1 truncate">
              <MapPin className="w-3 h-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{job.location}</span>
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-3">
              {job.checklist.total > 0 && (
                <span
                  className={cn(
                    "text-[11px] font-medium flex items-center gap-1",
                    job.checklist.done === job.checklist.total ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                  )}
                >
                  <ListChecks className="w-3 h-3" />
                  {job.checklist.done}/{job.checklist.total}
                </span>
              )}
              {showCrew &&
                (noCrew ? (
                  <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> No crew
                  </span>
                ) : (
                  <span className="flex -space-x-1.5">
                    {job.crew.slice(0, 4).map((m) => (
                      <span
                        key={m.profileId}
                        title={m.name}
                        className="w-5 h-5 rounded-full bg-primary/10 ring-2 ring-card text-primary text-[9px] font-bold flex items-center justify-center"
                      >
                        {initials(m.name)}
                      </span>
                    ))}
                  </span>
                ))}
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </div>
        </div>
      </div>
    </button>
  );
}

/** My Jobs — the crew's day. Owners and admins can flip to every job to dispatch. */
export default function JobsPage() {
  const { organizationId, companyId } = useOrg();
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === organizationId)?.membershipRole ?? "member";
  const canDispatch = role === "owner" || role === "admin";
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [showDone, setShowDone] = useState(false);

  // From a week back (to catch unfinished work) through two weeks ahead.
  const window = useMemo(() => {
    const now = Date.now();
    return { from: new Date(now - 7 * 86_400_000).toISOString(), to: new Date(now + 14 * 86_400_000).toISOString() };
  }, []);
  const { data: jobs, isLoading, isError, refetch, isFetching } = useJobs(organizationId, {
    scope,
    ...window,
    companyId: companyId ?? null,
    includeDone: showDone,
  });
  const groups = useMemo(() => groupJobsByDay(jobs ?? []), [jobs]);
  const unassigned = scope === "all" ? (jobs ?? []).filter((j) => j.crew.length === 0 && j.stage !== "done").length : 0;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{scope === "mine" ? "My Jobs" : "All Jobs"}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {scope === "mine" ? "Jobs you're on — checklist, photos and directions in one place" : "Every upcoming job and who's on it"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canDispatch && (
            <div role="tablist" className="flex rounded-lg border border-border bg-secondary p-0.5">
              {(["mine", "all"] as const).map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={scope === s}
                  onClick={() => setScope(s)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-semibold transition-colors",
                    scope === s ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s === "mine" ? "Mine" : "Everyone"}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Refresh"
            className="w-8 h-8 rounded-lg border border-border bg-secondary flex items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          </button>
        </div>
      </div>

      {unassigned > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-foreground">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          {unassigned} upcoming job{unassigned === 1 ? " has" : "s have"} no crew yet.
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center space-y-2">
          <p className="text-sm text-foreground">Couldn't load jobs.</p>
          <button onClick={() => void refetch()} className="text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center space-y-2">
          <ClipboardCheck className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{scope === "mine" ? "No jobs assigned to you" : "No upcoming jobs"}</p>
          <p className="text-xs text-muted-foreground max-w-xs mx-auto">
            {scope === "mine"
              ? "When someone puts you on a job, it shows up here and you'll get an email."
              : "Book jobs from the Calendar, then assign crew from the job."}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key} className="space-y-2">
              <h2
                className={cn(
                  "text-xs font-bold uppercase tracking-wider",
                  g.key === "earlier" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
                )}
              >
                {g.label} <span className="font-medium normal-case tracking-normal">· {g.jobs.length}</span>
              </h2>
              <div className="space-y-2">
                {g.jobs.map((j) => (
                  <JobCard key={j.id} job={j} showCrew={scope === "all"} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="rounded" />
        Show finished jobs
      </label>
    </div>
  );
}

/** One job, full screen. */
export function JobDetailPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const { organizationId } = useOrg();
  const { data: job, isLoading, isError, error } = useJob(organizationId, bookingId);

  return (
    <div className="max-w-3xl space-y-3">
      <Link to="/jobs" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> My Jobs
      </Link>
      {isLoading ? (
        <div className="space-y-3">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={4} />
        </div>
      ) : isError || !job ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-foreground">{error instanceof Error ? error.message : "Job not found."}</p>
        </div>
      ) : (
        <JobSheetView orgId={organizationId} job={job} />
      )}
    </div>
  );
}
