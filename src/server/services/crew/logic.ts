/**
 * Pure crew-dispatch rules (no I/O), shared by the service and its tests.
 */

export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_CHECKLIST_LABEL = 200;

/** Who to add and who to take off when the crew list is replaced. */
export function diffCrew(current: readonly string[], next: readonly string[]): { add: string[]; remove: string[] } {
  const now = new Set(current);
  const want = new Set(next);
  return {
    add: [...want].filter((id) => !now.has(id)),
    remove: [...now].filter((id) => !want.has(id)),
  };
}

/** Clean checklist labels: trimmed, non-empty, capped, de-duplicated (case-insensitive). */
export function cleanChecklistLabels(labels: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.replace(/\s+/g, " ").trim().slice(0, MAX_CHECKLIST_LABEL);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_CHECKLIST_ITEMS) break;
  }
  return out;
}

/** Template items not already on the job — applying a template twice adds nothing. */
export function itemsToAdd(existing: readonly string[], incoming: readonly unknown[]): string[] {
  const have = new Set(existing.map((l) => l.trim().toLowerCase()));
  const room = Math.max(0, MAX_CHECKLIST_ITEMS - existing.length);
  return cleanChecklistLabels(incoming)
    .filter((l) => !have.has(l.toLowerCase()))
    .slice(0, room);
}

export interface ChecklistProgress {
  done: number;
  total: number;
}

export function checklistProgress(items: ReadonlyArray<{ done_at: string | null }>): ChecklistProgress {
  return { done: items.filter((i) => i.done_at).length, total: items.length };
}

export type JobStage = "scheduled" | "en_route" | "in_progress" | "done" | "cancelled";

/** Where a job is in the field, from its status and timestamps. */
export function jobStage(b: { status: string; en_route_at: string | null; started_at: string | null }): JobStage {
  if (b.status === "completed") return "done";
  if (b.status === "cancelled" || b.status === "no_show") return "cancelled";
  if (b.started_at) return "in_progress";
  if (b.en_route_at) return "en_route";
  return "scheduled";
}

/** "Tue, Oct 6 · 9:00 a.m." in the brand's time zone. */
export function formatJobWhen(iso: string, timeZone: string | null): string {
  const d = new Date(iso);
  const tz = timeZone || "America/Toronto";
  const day = d.toLocaleDateString("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

/** The calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function localDay(iso: string | Date, timeZone: string | null): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleDateString("en-CA", { timeZone: timeZone || "America/Toronto" });
}
