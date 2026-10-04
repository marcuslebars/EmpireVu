import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Navigation,
  Pencil,
  Phone,
  Play,
  Receipt,
  Repeat,
  StickyNote,
  Truck,
  User,
} from "lucide-react";

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
import { toast } from "@/components/ui/sonner";
import { useCompleteJob, useJobEnRoute, useStartJob, useUpdateJob } from "@/lib/job-hooks";
import { checklistIncomplete, type JobSheet } from "@/lib/jobs-api";
import { STAGE_LABEL, directionsUrl, durationLabel, timeLabel, whenLabel } from "@/lib/jobs-format";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { CrewPicker } from "./CrewPicker";
import { JobChecklist } from "./JobChecklist";
import { JobPhotos } from "./JobPhotos";
import { JobMaterials, JobProfitCard, JobTime } from "./JobTimeAndCost";

export function StageBadge({ stage }: { stage: JobSheet["stage"] }) {
  const tone: Record<JobSheet["stage"], string> = {
    scheduled: "bg-secondary text-muted-foreground border-border",
    en_route: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
    in_progress: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
    done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    cancelled: "bg-destructive/10 text-destructive border-destructive/30",
  };
  return <span className={cn("text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap", tone[stage])}>{STAGE_LABEL[stage]}</span>;
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="rounded-xl border border-border bg-card p-4">{children}</section>;
}

/** The whole job on one screen — built to be used one-handed on a phone at the dock. */
export function JobSheetView({ orgId, job }: { orgId: string; job: JobSheet }) {
  const { session } = useAuth();
  const role = session?.organizations.find((o) => o.id === orgId)?.membershipRole ?? "member";
  const canSeeCosts = role === "owner" || role === "admin";
  const enRoute = useJobEnRoute(orgId, job.id);
  const start = useStartJob(orgId, job.id);
  const complete = useCompleteJob(orgId, job.id);
  const update = useUpdateJob(orgId, job.id);
  const [openItems, setOpenItems] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [location, setLocation] = useState(job.location ?? "");
  const [notes, setNotes] = useState(job.description ?? "");

  useEffect(() => {
    if (!editing) {
      setLocation(job.location ?? "");
      setNotes(job.description ?? "");
    }
  }, [job.location, job.description, editing]);

  const closed = job.stage === "done" || job.stage === "cancelled";
  const busy = enRoute.isPending || start.isPending || complete.isPending;
  const tz = job.timeZone;

  // No success toasts here: the stage badge and buttons change, and on phones a toast
  // would sit on top of the pinned action bar.
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  const onComplete = async (force: boolean) => {
    try {
      await complete.mutateAsync(force);
      setOpenItems(null);
    } catch (err) {
      const open = checklistIncomplete(err);
      if (open !== null) setOpenItems(open);
      else toast.error(err instanceof Error ? err.message : "Couldn't mark the job done.");
    }
  };

  const saveDetails = async () => {
    try {
      await update.mutateAsync({ location: location.trim() || null, description: notes.trim() || null });
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  return (
    <div className="space-y-3 pb-28 sm:pb-6">
      {/* Header */}
      <Section>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground">{job.title}</h1>
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {whenLabel(job.scheduledFor, tz)} · {durationLabel(job.durationMinutes)}
            </p>
            {job.companyName && <p className="text-xs text-muted-foreground mt-0.5">{job.companyName}</p>}
            {job.recurringJobId && (
              <Link to={`/recurring?open=${job.recurringJobId}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline mt-1">
                <Repeat className="w-3 h-3" /> Part of a recurring job
              </Link>
            )}
          </div>
          <StageBadge stage={job.stage} />
        </div>

        {/* Progress trail */}
        {(job.enRouteAt || job.startedAt || job.completedAt) && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {job.enRouteAt && <span>On the way {timeLabel(job.enRouteAt, tz)}</span>}
            {job.startedAt && <span>Started {timeLabel(job.startedAt, tz)}</span>}
            {job.completedAt && <span className="text-emerald-700 dark:text-emerald-400 font-medium">Done {timeLabel(job.completedAt, tz)}</span>}
          </div>
        )}
      </Section>

      {/* Customer + where */}
      <Section>
        <div className="space-y-3">
          {job.contactName ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <User className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium text-foreground truncate">{job.contactName}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {job.contactPhone && (
                  <>
                    <a href={`tel:${job.contactPhone}`} aria-label="Call customer" className="w-9 h-9 rounded-lg bg-secondary border border-border flex items-center justify-center text-foreground hover:bg-secondary/80">
                      <Phone className="w-4 h-4" />
                    </a>
                    <a href={`sms:${job.contactPhone}`} aria-label="Text customer" className="w-9 h-9 rounded-lg bg-secondary border border-border flex items-center justify-center text-foreground hover:bg-secondary/80">
                      <MessageSquare className="w-4 h-4" />
                    </a>
                  </>
                )}
                {job.contactEmail && (
                  <a href={`mailto:${job.contactEmail}`} aria-label="Email customer" className="w-9 h-9 rounded-lg bg-secondary border border-border flex items-center justify-center text-foreground hover:bg-secondary/80">
                    <Mail className="w-4 h-4" />
                  </a>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <User className="w-4 h-4" /> No customer linked
            </p>
          )}

          {!editing ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2 min-w-0">
                  <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <span className={cn("text-sm", job.location ? "text-foreground" : "text-muted-foreground")}>{job.location || "No location set"}</span>
                </div>
                {job.location && (
                  <a
                    href={directionsUrl(job.location)}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 flex items-center gap-1.5 px-3 h-9 rounded-lg bg-secondary border border-border text-xs font-medium text-foreground hover:bg-secondary/80"
                  >
                    <Navigation className="w-3.5 h-3.5" /> Directions
                  </a>
                )}
              </div>
              {job.description && (
                <div className="flex items-start gap-2">
                  <StickyNote className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap">{job.description}</p>
                </div>
              )}
              {!closed && (
                <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  <Pencil className="w-3 h-3" /> Edit location & notes
                </button>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <label className="block">
                <span className="block text-xs font-medium text-foreground mb-1">Where</span>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  maxLength={300}
                  placeholder="e.g. Wye Heritage Marina, dock C slip 14"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-foreground mb-1">Notes for the crew</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  placeholder="Gate code, where the keys are, what the customer asked for…"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 resize-y"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-foreground">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveDetails()}
                  disabled={update.isPending}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground flex items-center gap-1.5 disabled:opacity-60"
                >
                  {update.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
                </button>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section>
        <CrewPicker orgId={orgId} bookingId={job.id} crew={job.crew} disabled={closed} />
      </Section>

      {!(closed && job.checklistItems.length === 0) && (
        <Section>
          <JobChecklist orgId={orgId} bookingId={job.id} companyId={job.companyId} items={job.checklistItems} readOnly={closed} />
        </Section>
      )}

      <Section>
        <JobPhotos orgId={orgId} bookingId={job.id} canAdd={job.stage !== "cancelled"} />
      </Section>

      <Section>
        <div className="space-y-5">
          <JobTime orgId={orgId} bookingId={job.id} timeZone={job.timeZone} closed={closed} />
          <JobMaterials orgId={orgId} bookingId={job.id} readOnly={job.stage === "cancelled"} />
        </div>
      </Section>

      {canSeeCosts && (
        <Section>
          <JobProfitCard orgId={orgId} bookingId={job.id} />
        </Section>
      )}

      {job.stage === "done" && (
        <Section>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-foreground flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Job done
            </p>
            {job.invoiceId ? (
              <Link to={`/invoices?open=${job.invoiceId}`} className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
                <Receipt className="w-3.5 h-3.5" /> View invoice
              </Link>
            ) : null}
          </div>
        </Section>
      )}

      {/* Field actions — pinned to the bottom of the screen on phones. */}
      {!closed && (
        <div className="fixed sm:static inset-x-0 bottom-0 z-30 border-t sm:border-0 border-border bg-background/95 sm:bg-transparent backdrop-blur sm:backdrop-blur-none p-3 sm:p-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-0">
          <div className="flex gap-2 max-w-3xl mx-auto">
            {job.stage === "scheduled" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => enRoute.mutateAsync(undefined))}
                className="flex-1 h-12 rounded-xl text-sm font-semibold bg-secondary border border-border text-foreground flex items-center justify-center gap-2 hover:bg-secondary/80 disabled:opacity-60"
              >
                {enRoute.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />} On my way
              </button>
            )}
            {(job.stage === "scheduled" || job.stage === "en_route") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => start.mutateAsync(undefined))}
                className={cn(
                  "flex-1 h-12 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60",
                  job.stage === "en_route" ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-secondary border border-border text-foreground hover:bg-secondary/80",
                )}
              >
                {start.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Start job
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void onComplete(false)}
              className={cn(
                "flex-1 h-12 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60",
                job.stage === "in_progress" ? "bg-emerald-600 text-white hover:bg-emerald-600/90" : "bg-secondary border border-border text-foreground hover:bg-secondary/80",
              )}
            >
              {complete.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Mark done
            </button>
          </div>
        </div>
      )}

      <AlertDialog open={openItems !== null} onOpenChange={(o) => !o && setOpenItems(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Checklist isn't finished</AlertDialogTitle>
            <AlertDialogDescription>
              {openItems === 1 ? "1 item is" : `${openItems} items are`} still unticked. Mark the job done anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onComplete(true)}>Mark done anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
