/**
 * The Profit advisor's owner texts, built in code from the numbers (never by a model). PURE.
 *
 *   Weekly:  "This week: 6 jobs done, $8,420 billed, profit about $3,100 (37%). Best: Jones roof
 *            $1,200. Watch: Smith deck lost $180 (labour 9h over). Next 30 days: about $11k in,
 *            $7k out - fine. Text 'profit' for more."
 *   Tight:   "Cash looks tight around Nov 6 (about $2,400 short)"
 */
import type { Forecast } from "./forecast";
import { pct, shortDate, shortMoney, wholeDollars } from "./format";
import type { JobsSummary } from "./summary";

export const MAX_WEEKLY_CHARS = 480;

/** "Next 30 days: about $11k in, $7k out - fine." / "… - tight around Nov 6 (about $2,400 short)." PURE. */
export function forecastLine(f: Forecast, refYear: number): string {
  const w = f.windows.find((x) => x.days === 30) ?? f.windows[0];
  const head = `Next ${w.days} days: about ${shortMoney(w.inLikelyCents)} in, ${shortMoney(w.outLikelyCents)} out`;
  if (f.tight30.tight && f.tight30.date) return `${head} - tight around ${shortDate(f.tight30.date, refYear)} (about ${wholeDollars(f.tight30.shortCents)} short).`;
  return `${head} - fine.`;
}

/** The briefing / owner line when the next 30 days look tight, else null. PURE. */
export function tightLine(f: Forecast, refYear: number): string | null {
  if (!f.tight30.tight || !f.tight30.date) return null;
  return `Cash looks tight around ${shortDate(f.tight30.date, refYear)} (about ${wholeDollars(f.tight30.shortCents)} short)`;
}

/** What makes the week's numbers a guess, most important first. PURE. */
export function caveats(s: JobsSummary): string[] {
  const out: string[] = [];
  const n = s.missingRateNames.length;
  if (n > 0) out.push(`${n} crew ${n === 1 ? "has" : "have"} no pay rate - profit is a guess.`);
  if (s.unpriced > 0) out.push(`${s.unpriced} job${s.unpriced === 1 ? " has" : "s have"} no price yet.`);
  if (s.noCosts > 0 && n === 0) out.push(`${s.noCosts} job${s.noCosts === 1 ? " has" : "s have"} no hours or receipts logged.`);
  if (s.careVisits > 0) out.push(`${s.careVisits} free callback/warranty visit${s.careVisits === 1 ? "" : "s"}${s.careCostCents > 0 ? ` cost about ${wholeDollars(s.careCostCents)}` : ""}.`);
  return out;
}

/** The Friday money text. Shortened to fit (caveats, then the watch reason, then best go first). PURE. */
export function weeklyText(s: JobsSummary, f: Forecast | null, refYear: number): string {
  const done = s.jobs === 0 ? "This week: no jobs done." : `This week: ${s.jobs} job${s.jobs === 1 ? "" : "s"} done`;
  const money =
    s.jobs === 0
      ? ""
      : s.billedCents > 0
        ? `, ${wholeDollars(s.billedCents)} billed, ${s.profitCents >= 0 ? `profit about ${wholeDollars(s.profitCents)}` : `a loss of about ${wholeDollars(-s.profitCents)}`}${s.margin != null && s.profitCents >= 0 ? ` (${pct(s.margin)})` : ""}.`
        : ", nothing billed yet.";
  const best = s.best && s.jobs > 1 ? `Best: ${s.best.name} ${wholeDollars(s.best.profitCents)}.` : "";
  const watchCore = s.watch
    ? `Watch: ${s.watch.name} ${s.watch.profitCents < 0 ? `lost ${wholeDollars(-s.watch.profitCents)}` : `only ${pct(s.watch.margin ?? 0)} margin`}`
    : "";
  const watchFull = s.watch ? `${watchCore}${s.watch.reason ? ` (${s.watch.reason})` : ""}.` : "";
  const forecast = f ? forecastLine(f, refYear) : "";
  const close = "Text 'profit' for more.";
  const notes = caveats(s);
  const build = (parts: { best: boolean; watchReason: boolean; notes: number }) =>
    [`${done}${money}`, parts.best ? best : "", s.watch ? (parts.watchReason ? watchFull : `${watchCore}.`) : "", ...notes.slice(0, parts.notes), forecast, close]
      .filter((p) => p.trim())
      .join(" ");
  for (const parts of [
    { best: true, watchReason: true, notes: notes.length },
    { best: true, watchReason: true, notes: 1 },
    { best: true, watchReason: false, notes: 1 },
    { best: false, watchReason: false, notes: 1 },
    { best: false, watchReason: false, notes: 0 },
  ]) {
    const text = build(parts);
    if (text.length <= MAX_WEEKLY_CHARS) return text;
  }
  return build({ best: false, watchReason: false, notes: 0 }).slice(0, MAX_WEEKLY_CHARS);
}
