/**
 * Shared by the server (visit generation) and the browser (live preview).
 *
 * Recurrence rules — pure date maths on calendar dates (YYYY-MM-DD), no time zones.
 * The time of day and the brand's zone are applied when a visit becomes a booking.
 *
 *   weekly   every N weeks on the chosen weekdays (default: the start date's weekday)
 *   monthly  every N months on the start date's day (31st → last day of shorter months)
 *   yearly   every N years on the start date (Feb 29 → Feb 28 in other years)
 */

export type Frequency = "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  frequency: Frequency;
  interval: number;
  /** weekly only: 0 = Sunday … 6 = Saturday. */
  weekdays?: number[];
  startDate: string;
  endsOn?: string | null;
  maxOccurrences?: number | null;
}

const DAY = 86_400_000;
/** Hard stop so a malformed rule can never loop forever. */
const MAX_STEPS = 5000;

function toUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function ymdOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDaysYmd(ymd: string, days: number): string {
  return ymdOf(toUtc(ymd) + days * DAY);
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function weekdayOf(ymd: string): number {
  return new Date(toUtc(ymd)).getUTCDay();
}

/** Every occurrence of the rule from its start, in order, until `until` (inclusive). */
function* walk(rule: RecurrenceRule, until: string): Generator<string> {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const last = rule.endsOn && rule.endsOn < until ? rule.endsOn : until;
  if (rule.startDate > last) return;

  if (rule.frequency === "weekly") {
    const days = [...new Set((rule.weekdays?.length ? rule.weekdays : [weekdayOf(rule.startDate)]).filter((d) => d >= 0 && d <= 6))].sort();
    // Weeks are counted from the Sunday of the start date's week.
    const weekStart = toUtc(rule.startDate) - weekdayOf(rule.startDate) * DAY;
    for (let w = 0; w < MAX_STEPS; w += interval) {
      for (const d of days) {
        const date = ymdOf(weekStart + (w * 7 + d) * DAY);
        if (date < rule.startDate) continue;
        if (date > last) return;
        yield date;
      }
    }
    return;
  }

  const [sy, sm, sd] = rule.startDate.split("-").map(Number);
  for (let i = 0; i < MAX_STEPS; i++) {
    const monthsAhead = rule.frequency === "monthly" ? i * interval : i * interval * 12;
    const total = sm - 1 + monthsAhead;
    const year = sy + Math.floor(total / 12);
    const month0 = total % 12;
    const day = Math.min(sd, daysInMonth(year, month0));
    const date = ymdOf(Date.UTC(year, month0, day));
    if (date > last) return;
    yield date;
  }
}

/**
 * Occurrence dates within [from, to], honouring the end date and the occurrence cap
 * (counted from the very first visit, not from `from`).
 */
export function occurrencesBetween(rule: RecurrenceRule, from: string, to: string, limit = 400): string[] {
  const out: string[] = [];
  let index = 0;
  for (const date of walk(rule, to)) {
    index += 1;
    if (rule.maxOccurrences && index > rule.maxOccurrences) break;
    if (date < from) continue;
    out.push(date);
    if (out.length >= limit) break;
  }
  return out;
}

/** The first occurrence on or after `from`, or null when the series has finished. */
export function nextOccurrence(rule: RecurrenceRule, from: string): string | null {
  // Look up to ~10 years ahead — enough for "every 5 years".
  return occurrencesBetween(rule, from, addDaysYmd(from, 3700), 1)[0] ?? null;
}

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** "Every 2 weeks on Tue & Fri", "Monthly on the 15th", "Every year on May 1". */
export function describeRule(rule: RecurrenceRule): string {
  const n = Math.max(1, rule.interval || 1);
  const [, m, d] = rule.startDate.split("-").map(Number);
  let text: string;
  if (rule.frequency === "weekly") {
    const days = (rule.weekdays?.length ? [...rule.weekdays].sort() : [weekdayOf(rule.startDate)]);
    const dayText = days.length === 1 ? WEEKDAY[days[0]] : days.map((x) => WEEKDAY_SHORT[x]).join(" & ");
    text = n === 1 ? `Weekly on ${dayText}` : `Every ${n} weeks on ${dayText}`;
  } else if (rule.frequency === "monthly") {
    text = n === 1 ? `Monthly on the ${ordinal(d)}` : `Every ${n} months on the ${ordinal(d)}`;
  } else {
    text = n === 1 ? `Every year on ${MONTH[m - 1]} ${d}` : `Every ${n} years on ${MONTH[m - 1]} ${d}`;
  }
  if (rule.endsOn) text += `, until ${rule.endsOn}`;
  else if (rule.maxOccurrences) text += `, ${rule.maxOccurrences} times`;
  return text;
}
