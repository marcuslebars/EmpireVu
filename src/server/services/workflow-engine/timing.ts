import type { MessageTemplateData } from "@/server/services/workflow-engine/interpolate";

/**
 * Time math for workflow waits and schedules (Task 9). Pure + fully unit-tested.
 */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** "2d" | "4h" | "30m" | "90s" | "1w" → milliseconds, or null when unparseable. */
export function parseDuration(spec: string): number | null {
  const match = spec.trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  const unit = UNIT_MS[match[2].toLowerCase()];
  return Number.isFinite(value) && unit ? Math.round(value * unit) : null;
}

function resolvePath(path: string, data: MessageTemplateData): unknown {
  const parts = path.split(".");
  const root = parts[0];
  if (root === "contact" || root === "company" || root === "booking" || root === "quote") {
    let current: unknown = data[root];
    for (const segment of parts.slice(1)) {
      if (current == null || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return current ?? null;
  }
  return data.fields[path] ?? null;
}

/**
 * Resolve an `until` expression like "booking.scheduled_for - 24h" to an ISO instant, or
 * null when the referenced field can't be resolved to a date.
 */
export function resolveUntil(expr: string, data: MessageTemplateData): string | null {
  const match = expr.trim().match(/^(.+?)\s*([+-])\s*(\d+(?:\.\d+)?\s*[smhdw])$/i);
  const path = (match ? match[1] : expr).trim();
  const raw = resolvePath(path, data);
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const baseMs = new Date(raw).getTime();
  if (!Number.isFinite(baseMs)) return null;
  if (!match) return new Date(baseMs).toISOString();
  const offset = parseDuration(match[3]);
  if (offset == null) return new Date(baseMs).toISOString();
  return new Date(baseMs + (match[2] === "-" ? -offset : offset)).toISOString();
}

export interface WaitSpec {
  duration?: string;
  until?: string;
}

/**
 * The resume instant for a wait action. Prefers `duration` (now + duration), else `until`.
 * Falls back to `now` when neither resolves, so a mis-authored wait continues rather than
 * stalling the sequence forever.
 */
export function computeResumeAt(wait: WaitSpec, data: MessageTemplateData, nowMs: number = Date.now()): string {
  if (wait.duration) {
    const ms = parseDuration(wait.duration);
    if (ms != null) return new Date(nowMs + ms).toISOString();
  }
  if (wait.until) {
    const iso = resolveUntil(wait.until, data);
    if (iso) return iso;
  }
  return new Date(nowMs).toISOString();
}

// ── Timezone-aware daily slots (DST-safe; no dependency) ─────────────────────

/** Offset (localWallClock − UTC) in ms for an instant, in an IANA zone. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = Number(part.value);
  const asIfUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asIfUtc - utcMs;
}

/**
 * The UTC instant (ms) of today's local "HH:MM" in a zone, relative to `nowMs`. DST-safe:
 * the offset is computed at the target wall-clock, so 08:00 local is 08:00 local across a
 * spring-forward / fall-back boundary.
 */
export function localDailySlotUtcMs(hhmm: string, timeZone: string, nowMs: number): number {
  const [h, min] = hhmm.split(":").map((n) => Number.parseInt(n, 10));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const map: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = Number(part.value);
  const naiveUtc = Date.UTC(map.year, map.month - 1, map.day, h || 0, min || 0, 0);
  return naiveUtc - tzOffsetMs(naiveUtc, timeZone);
}
