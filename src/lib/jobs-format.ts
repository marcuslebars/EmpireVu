import type { JobStage, JobSummary } from "@/lib/jobs-api";

/** YYYY-MM-DD of an instant in a time zone. */
export function dayKey(iso: string | Date, timeZone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleDateString("en-CA", { timeZone });
}

export function timeLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
}

export function whenLabel(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-CA", { timeZone, weekday: "short", month: "short", day: "numeric" });
  return `${day} · ${timeLabel(iso, timeZone)}`;
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export interface JobGroup {
  key: string;
  label: string;
  jobs: JobSummary[];
}

/**
 * Group jobs by day in their brand's time zone: "Earlier — not done" (past days still
 * open), "Today", "Tomorrow", then dated headings. Done jobs stay under their day.
 */
export function groupJobsByDay(jobs: readonly JobSummary[], now: Date = new Date()): JobGroup[] {
  const groups = new Map<string, JobGroup>();
  for (const job of jobs) {
    const tz = job.timeZone;
    const today = dayKey(now, tz);
    const tomorrow = dayKey(new Date(now.getTime() + 86_400_000), tz);
    const day = dayKey(job.scheduledFor, tz);
    let key = day;
    let label: string;
    if (day < today) {
      if (job.stage === "done") continue; // yesterday's finished work isn't on today's list
      key = "earlier";
      label = "Earlier — not done";
    } else if (day === today) label = "Today";
    else if (day === tomorrow) label = "Tomorrow";
    else label = new Date(job.scheduledFor).toLocaleDateString("en-CA", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
    const group = groups.get(key) ?? { key, label, jobs: [] };
    group.jobs.push(job);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.key === "earlier" ? -1 : b.key === "earlier" ? 1 : a.key.localeCompare(b.key)));
}

export const STAGE_LABEL: Record<JobStage, string> = {
  scheduled: "Scheduled",
  en_route: "On the way",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** Google Maps directions to a free-text place ("Wye Heritage Marina, slip C14"). */
export function directionsUrl(location: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`;
}

/** "1h 05m" / "45m" */
export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
