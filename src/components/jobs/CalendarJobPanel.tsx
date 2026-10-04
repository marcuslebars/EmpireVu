import { Link } from "react-router-dom";
import { ClipboardCheck, ListChecks, MapPin } from "lucide-react";

import { useJob } from "@/lib/job-hooks";
import { CrewPicker } from "./CrewPicker";

/** Crew + field summary inside the calendar's booking panel, with a link to the full job sheet. */
export function CalendarJobPanel({ orgId, bookingId }: { orgId: string; bookingId: string }) {
  const { data: job, isLoading } = useJob(orgId, bookingId);
  if (isLoading || !job) {
    return <div className="h-16 rounded-lg bg-secondary/50 animate-pulse" />;
  }
  const closed = job.stage === "done" || job.stage === "cancelled";
  return (
    <div className="space-y-3">
      <CrewPicker orgId={orgId} bookingId={bookingId} crew={job.crew} disabled={closed} compact />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {job.location && (
          <span className="flex items-center gap-1 text-foreground/80">
            <MapPin className="w-3 h-3" /> {job.location}
          </span>
        )}
        {job.checklist.total > 0 && (
          <span className="flex items-center gap-1">
            <ListChecks className="w-3 h-3" /> {job.checklist.done}/{job.checklist.total} checklist
          </span>
        )}
      </div>
      <Link
        to={`/jobs/${bookingId}`}
        className="flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-lg text-xs font-medium bg-secondary text-foreground hover:bg-secondary/80 border border-border"
      >
        <ClipboardCheck className="w-3.5 h-3.5" /> Open job sheet (location, checklist, photos)
      </Link>
    </div>
  );
}
