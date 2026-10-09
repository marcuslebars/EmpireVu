/**
 * PURE: companies.hours (any of the shapes it is stored in) → online-booking bookable hours.
 * Golden-tested in src/test/dfy-autolive.test.ts.
 *
 * Shapes accepted (the wizard, the intake enrichment and Google Places all write slightly
 * different things — the shared schema only says "jsonb"):
 *   • { monday: { open: "08:00", close: "17:00" }, saturday: "closed", … } (day keys: full or 3-letter)
 *   • [{ day: "mon", open: "8:00", close: "17:00" }, …]  (also under a `days` key)
 *   • Google: { periods: [{ open: { day: 1, time: "0800" }, close: { day: 1, time: "1700" } }] }
 *   • text: { summary | text: "Mon–Fri 8am–5pm, Sat 9am–1pm" } or { weekdayText | weekday_text: ["Monday: 8:00 AM – 5:00 PM", …] }
 * Anything we can't read confidently → null (booking keeps its defaults; never a guess).
 */

export interface BookableHours {
  startHour: number;
  endHour: number;
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
}

const DAY_INDEX: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

interface DaySpan {
  day: number;
  openMin: number;
  closeMin: number;
}

function dayOf(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 6) return raw;
  if (typeof raw !== "string") return null;
  return DAY_INDEX[raw.trim().toLowerCase().replace(/\.$/, "")] ?? null;
}

/** "8", "8am", "8:30 PM", "17:00", "0800", "noon" → minutes after midnight. */
export function parseTime(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim().toLowerCase().replace(/\./g, "");
  if (text === "noon") return 12 * 60;
  if (text === "midnight") return 24 * 60;
  const compact = /^(\d{2})(\d{2})$/.exec(text);
  if (compact) return Number(compact[1]) * 60 + Number(compact[2]);
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (minute > 59 || hour > 24) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix.startsWith("p") && hour !== 12) hour += 12;
    if (suffix.startsWith("a") && hour === 12) hour = 0;
  }
  return hour * 60 + minute;
}

function span(day: number | null, open: unknown, close: unknown): DaySpan | null {
  if (day === null) return null;
  const openMin = parseTime(open);
  let closeMin = parseTime(close);
  if (openMin === null || closeMin === null) return null;
  if (closeMin === 0) closeMin = 24 * 60;
  return closeMin > openMin ? { day, openMin, closeMin } : null;
}

const DASH = /\s*(?:-|–|—|to)\s*/;

/** "Mon–Fri", "Monday", "Sat & Sun", "Mon, Wed" → day indexes. */
function parseDays(text: string): number[] | null {
  const parts = text.split(/\s*(?:,|&|\band\b)\s*/).filter(Boolean);
  const out: number[] = [];
  for (const part of parts) {
    const range = part.split(DASH);
    if (range.length === 2) {
      const a = dayOf(range[0]);
      const b = dayOf(range[1]);
      if (a === null || b === null) return null;
      for (let d = a; ; d = (d + 1) % 7) {
        out.push(d);
        if (d === b) break;
      }
    } else {
      const d = dayOf(part);
      if (d === null) return null;
      out.push(d);
    }
  }
  return out.length ? out : null;
}

/** One "Mon–Fri 8am–5pm" / "Monday: 8:00 AM – 5:00 PM" / "Sun closed" segment. */
function parseSegment(segment: string): DaySpan[] | null {
  const text = segment.trim().replace(/\u202f|\u2009/g, " ");
  if (!text) return [];
  const m = /^([a-z.,&\s–—-]+?)\s*:?\s+((?:\d|closed|open|noon).*)$/i.exec(text);
  if (!m) return null;
  const days = parseDays(m[1].replace(/:$/, "").trim());
  if (!days) return null;
  const hours = m[2].trim().toLowerCase();
  if (/^closed$/.test(hours)) return [];
  if (/open 24 hours/.test(hours)) return days.map((day) => ({ day, openMin: 0, closeMin: 24 * 60 }));
  const times = hours.split(DASH);
  if (times.length !== 2) return null;
  // "8–5pm" → the open time borrows the close time's am/pm when it makes sense.
  let open = times[0];
  const close = times[1];
  const closeSuffix = /(am|pm)$/.exec(close.replace(/\s/g, ""))?.[1];
  if (closeSuffix && !/(am|pm|a|p)$/.test(open.replace(/\s/g, ""))) {
    const asSame = parseTime(`${open}${closeSuffix}`);
    const closeMin = parseTime(close);
    open = asSame !== null && closeMin !== null && asSame < closeMin ? `${open}${closeSuffix}` : `${open}am`;
  }
  // "8–5" (no am/pm anywhere): a close time before the open time is in the afternoon.
  let closeText = close;
  const bareOpen = parseTime(open);
  const bareClose = parseTime(close);
  if (!closeSuffix && bareOpen !== null && bareClose !== null && bareClose <= bareOpen && bareClose + 720 > bareOpen && bareClose < 720) {
    const minutes = bareClose + 720;
    closeText = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  }
  const spans = days.map((day) => span(day, open, closeText));
  return spans.every((s): s is DaySpan => s !== null) ? spans : null;
}

function parseText(text: string): DaySpan[] | null {
  const segments = text.split(/\s*(?:;|\n|,(?=\s*[a-z]{3}))\s*/i).filter((s) => s.trim());
  const out: DaySpan[] = [];
  for (const segment of segments) {
    const parsed = parseSegment(segment);
    if (!parsed) return null;
    out.push(...parsed);
  }
  return out;
}

function spansFrom(hours: unknown): DaySpan[] | null {
  if (!hours) return null;
  if (typeof hours === "string") return parseText(hours);
  if (Array.isArray(hours)) {
    const spans = hours.map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as Record<string, unknown>;
      return span(dayOf(e.day), e.open ?? e.opens, e.close ?? e.closes);
    });
    return spans.every((s): s is DaySpan => s !== null) ? spans : null;
  }
  if (typeof hours !== "object") return null;
  const record = hours as Record<string, unknown>;

  if (Array.isArray(record.periods)) {
    const spans = record.periods.map((p) => {
      if (!p || typeof p !== "object") return null;
      const entry = p as Record<string, unknown>;
      // The enrichment's own shape (places.ts hoursFromPlaces): { day: 1, open: "07:00", close: "18:00" | null }.
      if (typeof entry.open === "string") {
        if (entry.close === null || entry.close === undefined) {
          const day = dayOf(entry.day);
          return day === null ? null : { day, openMin: 0, closeMin: 24 * 60 };
        }
        return span(dayOf(entry.day), entry.open, entry.close);
      }
      const open = entry.open as Record<string, unknown> | undefined;
      const close = (p as Record<string, unknown>).close as Record<string, unknown> | undefined;
      if (!open) return null;
      if (!close) return { day: dayOf(open.day) ?? 0, openMin: 0, closeMin: 24 * 60 }; // Google: always open
      const openTime = typeof open.time === "string" ? open.time : `${String(open.hour ?? "")}:${String(open.minute ?? 0).padStart(2, "0")}`;
      const closeTime = typeof close.time === "string" ? close.time : `${String(close.hour ?? "")}:${String(close.minute ?? 0).padStart(2, "0")}`;
      return span(dayOf(open.day), openTime, closeTime);
    });
    return spans.every((s): s is DaySpan => s !== null) ? spans : null;
  }
  if (Array.isArray(record.days)) return spansFrom(record.days);
  const weekdayText = record.weekdayText ?? record.weekday_text ?? record.weekdayDescriptions;
  if (Array.isArray(weekdayText)) return parseText(weekdayText.filter((t) => typeof t === "string").join("\n"));
  if (typeof record.summary === "string") return parseText(record.summary);
  if (typeof record.text === "string") return parseText(record.text);

  const out: DaySpan[] = [];
  let sawDay = false;
  for (const [key, value] of Object.entries(record)) {
    const day = dayOf(key);
    if (day === null) continue;
    sawDay = true;
    if (value === null || value === false || (typeof value === "string" && /closed/i.test(value))) continue;
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (v.closed === true) continue;
      const s = span(day, v.open ?? v.opens ?? v.start, v.close ?? v.closes ?? v.end);
      if (!s) return null;
      out.push(s);
    } else if (typeof value === "string") {
      const parsed = parseSegment(`${key} ${value}`);
      if (!parsed) return null;
      out.push(...parsed);
    } else {
      return null;
    }
  }
  return sawDay ? out : null;
}

/**
 * The booking window that covers the business's stated hours: earliest open → latest close
 * (whole hours), on the days they're open. null when the hours can't be read or are empty.
 */
export function bookingHoursFromCompanyHours(hours: unknown): BookableHours | null {
  const spans = spansFrom(hours);
  if (!spans || spans.length === 0) return null;
  const startHour = Math.floor(Math.min(...spans.map((s) => s.openMin)) / 60);
  const endHour = Math.ceil(Math.max(...spans.map((s) => s.closeMin)) / 60);
  if (!(endHour > startHour) || startHour < 0 || endHour > 24) return null;
  const workingDays = Array.from(new Set(spans.map((s) => s.day))).sort((a, b) => a - b);
  return { startHour, endHour: Math.min(24, endHour), workingDays };
}
