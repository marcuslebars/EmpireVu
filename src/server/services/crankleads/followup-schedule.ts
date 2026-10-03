/**
 * PURE timing for the CrankLeads setup follow-ups (golden-tested in
 * src/test/crankleads-setup-followups.test.ts). No I/O, no clock — `nowMs` is always passed in.
 *
 *   • Reminder stages are BUSINESS days after provisioning, counted in the company's timezone:
 *     day1 = next business day, day3, day5, day10 (Mon–Fri; weekends never count).
 *   • A reminder only goes out on a weekday between 09:00 and 18:00 company-local time.
 *   • If several stages are due (the worker was down, or the buyer was provisioned long ago),
 *     only the LATEST due stage is sent — the earlier ones are superseded, never sent late.
 *   • At most one reminder per purchase per company-local day.
 *   • The "you're live" confirmation is a reply to the owner's own action, so it may go out any
 *     day, but still only between 08:00 and 21:00 local (never at night).
 */

export const REMINDER_STAGES = ["day1", "day3", "day5", "day10"] as const;
export type ReminderStage = (typeof REMINDER_STAGES)[number];
export type FollowupStage = ReminderStage | "live";

/** Business days after provisioning at which each reminder becomes due. */
export const REMINDER_BUSINESS_DAYS: Record<ReminderStage, number> = { day1: 1, day3: 3, day5: 5, day10: 10 };

/** Reminders: weekdays, [09:00, 18:00) local. */
export const REMINDER_WINDOW = { startHour: 9, endHour: 18 } as const;
/** Live confirmation: any day, [08:00, 21:00) local. */
export const LIVE_WINDOW = { startHour: 8, endHour: 21 } as const;

/** Stop chasing (and stop evaluating for reminders) this many calendar days after provisioning. */
export const FOLLOWUP_HORIZON_DAYS = 30;

export interface LocalClock {
  /** YYYY-MM-DD in the zone. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `ms` in `timeZone` (falls back to America/Toronto for an invalid zone). */
export function localClock(timeZone: string, ms: number): LocalClock {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return localClock("America/Toronto", ms);
  }
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) if (part.type !== "literal") map[part.type] = part.value;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    weekday: WEEKDAYS[map.weekday] ?? 0,
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
  };
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** `date` (YYYY-MM-DD) plus `n` business days (Mon–Fri). n = 0 → the date itself. */
export function addBusinessDays(date: string, n: number): string {
  const d = parseDate(date);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) left -= 1;
  }
  return formatDate(d);
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
}

/** The company-local date each reminder stage becomes due. */
export function reminderDueDates(provisionedAtMs: number, timeZone: string): Record<ReminderStage, string> {
  const start = localClock(timeZone, provisionedAtMs).date;
  return {
    day1: addBusinessDays(start, REMINDER_BUSINESS_DAYS.day1),
    day3: addBusinessDays(start, REMINDER_BUSINESS_DAYS.day3),
    day5: addBusinessDays(start, REMINDER_BUSINESS_DAYS.day5),
    day10: addBusinessDays(start, REMINDER_BUSINESS_DAYS.day10),
  };
}

/** Is `nowMs` inside the reminder window (weekday, 09:00–18:00 local)? */
export function inReminderWindow(timeZone: string, nowMs: number): boolean {
  const clock = localClock(timeZone, nowMs);
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  return clock.hour >= REMINDER_WINDOW.startHour && clock.hour < REMINDER_WINDOW.endHour;
}

/** Is `nowMs` inside the live-confirmation window (any day, 08:00–21:00 local)? */
export function inLiveWindow(timeZone: string, nowMs: number): boolean {
  const { hour } = localClock(timeZone, nowMs);
  return hour >= LIVE_WINDOW.startHour && hour < LIVE_WINDOW.endHour;
}

export interface SelectReminderInput {
  provisionedAtMs: number;
  nowMs: number;
  timeZone: string;
  /** Reminder stages already claimed for this purchase (any outcome). */
  sentStages: ReadonlySet<string>;
  /** Company-local dates on which a reminder was already claimed for this purchase. */
  sentLocalDates: ReadonlySet<string>;
}

export type ReminderSkipReason = "outside_window" | "nothing_due" | "already_sent_today" | "past_horizon" | "all_sent";

/** `stage` + `localDate` are set exactly when `send` is true; `reason` exactly when it is false. */
export interface ReminderDecision {
  send: boolean;
  stage: ReminderStage | null;
  localDate: string | null;
  reason: ReminderSkipReason | null;
}

function skip(reason: ReminderSkipReason): ReminderDecision {
  return { send: false, stage: null, localDate: null, reason };
}

/** Which reminder (if any) to send right now. */
export function selectReminderStage(input: SelectReminderInput): ReminderDecision {
  const today = localClock(input.timeZone, input.nowMs).date;
  const start = localClock(input.timeZone, input.provisionedAtMs).date;
  if (calendarDaysBetween(start, today) > FOLLOWUP_HORIZON_DAYS) return skip("past_horizon");
  if (REMINDER_STAGES.every((stage) => input.sentStages.has(stage))) return skip("all_sent");
  if (!inReminderWindow(input.timeZone, input.nowMs)) return skip("outside_window");
  if (input.sentLocalDates.has(today)) return skip("already_sent_today");

  const due = reminderDueDates(input.provisionedAtMs, input.timeZone);
  // Latest stage whose due date has arrived. If it was already sent, nothing new is due —
  // an earlier unsent stage is superseded, never sent late.
  const latestDue = [...REMINDER_STAGES].reverse().find((stage) => due[stage] <= today) ?? null;
  if (!latestDue || input.sentStages.has(latestDue)) return skip("nothing_due");
  return { send: true, stage: latestDue, localDate: today, reason: null };
}
