/**
 * The morning briefing text (docs/ai-staff.md → "Office manager"). PURE: data in, one short
 * contractor-voice text out, at most 4 SMS segments (612 GSM-7 characters including the
 * platform prefix). Parts with nothing to say are left out; a truly quiet day is one line.
 *
 *   Morning Dana - Northshore Roofing, Tue Oct 13.
 *   Today: 5 jobs, first at 8am. Mike 3, Sam 1, 1 unassigned.
 *   Weather: today rain 80%, 6 mm - 2 jobs at risk.
 *   Money: $1,240 came in yesterday, $3,400 overdue (4 invoices).
 *   Payment failed: Jamie Lee $500 (INV-30).            ← the Bookkeeper's 8am items, folded in
 *   Waiting on you: #12 AI estimate for Jamie Lee...; #13 Win-back text to 42...; +1 more.
 *   Yesterday: 3 new leads, 2 quotes sent, 1 approved. AI handled 8 text chats and 2 calls.
 *   Reply "today" for details.
 */

/** 4 GSM-7 segments of 153 septets. */
export const MAX_BRIEFING_SEPTETS = 612;

export interface JobsPart {
  count: number;
  firstStartIso: string | null;
  /** Crew members with jobs today (first names), busiest first. */
  members: Array<{ first: string; count: number }>;
  unassigned: number;
}

export interface WeatherDayPart {
  /** "rain 80%, 6 mm" when the daytime forecast crosses the owner's limits, else null. */
  reason: string | null;
  /** Weather-sensitive open jobs whose own window is at risk. */
  atRiskJobs: number;
}

export interface WeatherPart {
  today: WeatherDayPart;
  tomorrow: WeatherDayPart;
}

export interface MoneyPart {
  collectedCents: number;
  overdueCents: number;
  overdueCount: number;
}

export interface WaitingPart {
  items: Array<{ code: number | null; summary: string }>;
  total: number;
}

export interface SincePart {
  /** "Yesterday" / "Since Saturday". */
  label: string;
  leads: number;
  quotesSent: number;
  quotesApproved: number;
  textChats: number;
  calls: number;
}

export interface BriefingInput {
  ownerFirstName: string | null;
  businessName: string;
  /** "Tue Oct 13" */
  dayLabel: string;
  timeZone: string;
  jobs: JobsPart | null;
  weather: WeatherPart | null;
  money: MoneyPart | null;
  /** "yesterday" / "since Saturday" — for the money line. */
  periodPhrase: string;
  /** The Bookkeeper's alert lines folded in, most important first. */
  fold: string[];
  waiting: WaitingPart | null;
  since: SincePart | null;
  /** Heads-ups from other AI staff (staff-items.ts), most urgent first. */
  staff?: string[];
  /** Parts whose read failed: never claim "no jobs" / "nothing waiting" for them. */
  unreadable?: { jobs?: boolean; waiting?: boolean };
  /** Septets available (612 minus the platform prefix). */
  maxSeptets?: number;
}

export interface ComposedBriefing {
  text: string;
  quiet: boolean;
  /** How many of `fold` made it into the text (in order). Only these may be marked reported. */
  foldIncluded: number;
}

/** GSM-7 extension characters count twice. PURE. */
export function septets(text: string): number {
  let n = 0;
  for (const ch of text) n += "^{}\\[~]|€".includes(ch) ? 2 : 1;
  return n;
}

/** Plain ASCII (so GSM-7, never UCS-2 which would halve the segment size). PURE. */
export function gsmPlain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/`/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\S\n]/g, " ")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Cut to at most `max` GSM septets, ending "...". PURE. */
function clipSeptets(text: string, max: number): string {
  if (septets(text) <= max) return text;
  let cut = text;
  while (cut && septets(`${cut}...`) > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

function clipOne(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 3)).trimEnd()}...` : t;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "$1,240" (whole dollars, rounded) for the owner. PURE. */
export function dollars(cents: number): string {
  return `$${groupThousands(Math.round((Number.isFinite(cents) ? cents : 0) / 100))}`;
}

/** "8am" / "8:30am" in the company's zone. PURE. */
export function clock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h12" }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().replace(/\./g, "");
  return `${hour}${minute === "00" ? "" : `:${minute}`}${period}`;
}

/** End a sentence with "." unless it already ends in terminal punctuation ("...", "?", "!"). PURE. */
export function sentence(text: string): string {
  const t = text.trimEnd();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function jobsLine(jobs: JobsPart | null, timeZone: string, withCrew = true): string | null {
  if (!jobs || jobs.count <= 0) return null;
  const head = `Today: ${plural(jobs.count, "job")}${jobs.firstStartIso ? `, first at ${clock(jobs.firstStartIso, timeZone)}` : ""}.`;
  if (!withCrew) return head;
  if (jobs.members.length === 0) return `${head} None assigned yet.`;
  const crew = jobs.members.map((m) => `${m.first} ${m.count}`);
  if (jobs.unassigned > 0) crew.push(`${jobs.unassigned} unassigned`);
  return `${head} ${sentence(crew.join(", "))}`;
}

function weatherDay(label: string, day: WeatherDayPart): string | null {
  if (!day.reason && day.atRiskJobs <= 0) return null;
  const risk = day.atRiskJobs > 0 ? `${plural(day.atRiskJobs, "job")} at risk` : null;
  return [label, day.reason, risk ? (day.reason ? `- ${risk}` : risk) : null].filter(Boolean).join(" ");
}

export function weatherLine(weather: WeatherPart | null, withTomorrow = true): string | null {
  if (!weather) return null;
  const parts = [weatherDay("today", weather.today), withTomorrow ? weatherDay("tomorrow", weather.tomorrow) : null].filter((x): x is string => Boolean(x));
  return parts.length ? sentence(`Weather: ${parts.join("; ")}`) : null;
}

export function moneyLine(money: MoneyPart | null, periodPhrase: string): string | null {
  if (!money) return null;
  const parts: string[] = [];
  if (money.collectedCents > 0) parts.push(`${dollars(money.collectedCents)} came in ${periodPhrase}`);
  if (money.overdueCents > 0) parts.push(`${dollars(money.overdueCents)} overdue (${plural(money.overdueCount, "invoice")})`);
  return parts.length ? sentence(`Money: ${parts.join(", ")}`) : null;
}

export function waitingLine(waiting: WaitingPart | null, maxItems = 3, clipTo = 55): string | null {
  if (!waiting || waiting.total <= 0) return null;
  if (maxItems <= 0) return `Waiting on you: ${plural(waiting.total, "approval")} - text "waiting" for the list.`;
  const shown = waiting.items.slice(0, maxItems).map((i) => `${i.code != null ? `#${i.code} ` : ""}${clipOne(i.summary, clipTo)}`);
  const more = waiting.total - shown.length;
  return sentence(`Waiting on you: ${shown.join("; ")}${more > 0 ? `; +${more} more` : ""}`);
}

export function sinceLine(since: SincePart | null): string | null {
  if (!since) return null;
  const parts: string[] = [];
  if (since.leads > 0) parts.push(plural(since.leads, "new lead"));
  if (since.quotesSent > 0) parts.push(`${plural(since.quotesSent, "quote")} sent`);
  if (since.quotesApproved > 0) parts.push(`${since.quotesApproved} approved`);
  const ai: string[] = [];
  if (since.textChats > 0) ai.push(plural(since.textChats, "text chat"));
  if (since.calls > 0) ai.push(plural(since.calls, "call"));
  const sentences: string[] = [];
  if (parts.length) sentences.push(sentence(`${since.label}: ${parts.join(", ")}`));
  if (ai.length) sentences.push(sentence(`${parts.length ? "AI" : `${since.label}: AI`} handled ${ai.join(" and ")}`));
  return sentences.length ? sentences.join(" ") : null;
}

export const REPLY_HINT = 'Reply "today" for details.';

/** The briefing text, trimmed to fit. PURE. */
export function composeBriefing(input: BriefingInput): ComposedBriefing {
  const max = input.maxSeptets ?? MAX_BRIEFING_SEPTETS;
  const greet = gsmPlain(sentence(`Morning${input.ownerFirstName ? ` ${input.ownerFirstName}` : ""} - ${input.businessName}, ${input.dayLabel}`));

  const unreadableJobs = input.unreadable?.jobs === true;
  const unreadableWaiting = input.unreadable?.waiting === true;
  const quiet =
    !unreadableJobs &&
    !unreadableWaiting &&
    !jobsLine(input.jobs, input.timeZone) &&
    !weatherLine(input.weather) &&
    !moneyLine(input.money, input.periodPhrase) &&
    input.fold.length === 0 &&
    (input.staff ?? []).length === 0 &&
    !waitingLine(input.waiting) &&
    !sinceLine(input.since);
  if (quiet) {
    const text = gsmPlain(`Morning${input.ownerFirstName ? ` ${input.ownerFirstName}` : ""} - all quiet at ${input.businessName} today (${input.dayLabel}): no jobs booked and nothing waiting on you.`);
    return { text: clipSeptets(text, max), quiet: true, foldIncluded: 0 };
  }

  // Reductions, applied in order until the text fits.
  const staff = (input.staff ?? []).map((line) => sentence(line));
  const state = { waitClip: 55, waitItems: 3, since: true, crew: true, fold: input.fold.length, tomorrow: true, staff: staff.length };
  const build = () =>
    gsmPlain(
      [
        greet,
        unreadableJobs ? "Today's jobs: couldn't load them - check the app." : jobsLine(input.jobs, input.timeZone, state.crew),
        weatherLine(input.weather, state.tomorrow),
        moneyLine(input.money, input.periodPhrase),
        ...input.fold.slice(0, state.fold),
        ...staff.slice(0, state.staff),
        unreadableWaiting ? 'Approvals: couldn\'t load them - text "waiting".' : waitingLine(input.waiting, state.waitItems, state.waitClip),
        state.since ? sinceLine(input.since) : null,
        REPLY_HINT,
      ]
        .filter((x): x is string => Boolean(x))
        .join("\n"),
    );
  const steps: Array<() => boolean> = [
    () => (state.waitClip > 32 ? ((state.waitClip = 32), true) : false),
    () => (state.waitItems > 1 ? ((state.waitItems = 1), true) : false),
    () => (state.since ? ((state.since = false), true) : false),
    () => (state.staff > 2 ? ((state.staff = 2), true) : false),
    () => (state.crew ? ((state.crew = false), true) : false),
    () => (state.tomorrow ? ((state.tomorrow = false), true) : false),
    () => (state.waitItems > 0 ? ((state.waitItems = 0), true) : false),
    () => (state.staff > 1 ? ((state.staff = 1), true) : false),
    () => (state.staff > 0 ? ((state.staff = 0), true) : false),
  ];
  let text = build();
  for (const step of steps) {
    if (septets(text) <= max) break;
    if (step()) text = build();
  }
  // Last resort: drop folded money lines from the end (they stay unreported and come tomorrow).
  while (septets(text) > max && state.fold > 0) {
    state.fold -= 1;
    text = build();
  }
  // Never reached with real data (every line above is bounded); keep the cap absolute anyway.
  text = clipSeptets(text, max);
  return { text, quiet: false, foldIncluded: state.fold };
}
