/**
 * Moving a batch of jobs the owner approved (weather_reschedule, bulk_reschedule): re-check
 * every job and its new time, move it through the normal booking service (rescheduleBooking —
 * activity event, reminder re-timing), then text the customer the new time + their manage link
 * (queued until customer hours). Idempotent: a job already at its new time is left alone and
 * its text is deduplicated per approval + booking.
 */
import type { Tables } from "@/server/db/database.types";
import { rescheduleBooking } from "@/server/services/bookings";
import type { AdminClient, ApprovalDecision, ExecuteResult, OwnerApprovalRow } from "@/server/services/front-desk/contracts";
import { ctxFor } from "@/server/services/owner-channel/common";
import { loadDispatchCompany, manageUrl, type DispatchCompany } from "./company";
import type { Db } from "./db-types";
import { greeting, sendOrQueue, type SendOutcome } from "./messages";
import { loadSlotContext, slotStillOpen } from "./slots";
import { dayLabel, nextLocalTime, sentence, shortLabel, timeLabel, whenLabel } from "./time";

export interface PlannedMove {
  bookingId: string;
  contactId: string | null;
  /** "Sam Lee" (owner-facing). */
  who: string;
  /** "Sam" (customer greeting). */
  firstName: string;
  /** The job, as the customer text says it ("roof repair"). */
  job: string;
  fromStartsAt: string;
  toStartsAt: string;
  toWindowKey: string | null;
  /** Owner-facing forecast reason ("rain 80%, 6 mm"), weather only. */
  reason?: string | null;
  /** Customer-facing reason ("Rain is in the forecast"), weather only. */
  customerReason?: string | null;
}

export type MoveFlavour = "weather" | "bulk";

/** The exact text the customer gets for a move. PURE. */
export function movedCustomerText(input: { flavour: MoveFlavour; businessName: string; move: PlannedMove; timeZone: string; link: string | null }): string {
  const { move, timeZone } = input;
  const hello = `${greeting(move.firstName)}, it's ${input.businessName}.`;
  const tail = input.link ? `Need a different time? ${input.link}` : "Reply here if that time doesn't work.";
  if (input.flavour === "weather") {
    return `${hello} ${sentence(`${move.customerReason || "The weather doesn't look good"} for your ${move.job} on ${dayLabel(move.fromStartsAt, timeZone)}, so we've moved it to ${whenLabel(move.toStartsAt, timeZone)}`)} ${tail}`;
  }
  return `${hello} ${sentence(`We need to move your ${move.job} from ${dayLabel(move.fromStartsAt, timeZone)} to ${whenLabel(move.toStartsAt, timeZone)}`)} Sorry for the change. ${tail}`;
}

/** Placeholder used in owner summaries where each customer's own link goes. */
export const LINK_PLACEHOLDER = "[their booking link]";

/** "Sam Lee roof repair Thu 9am to Fri 9am (rain 80%, 6 mm)" PURE. */
export function moveLine(move: PlannedMove, timeZone: string): string {
  const reason = move.reason ? ` (${move.reason})` : "";
  return `${move.who} ${move.job} ${shortLabel(move.fromStartsAt, timeZone)} to ${shortLabel(move.toStartsAt, timeZone)}${reason}`;
}

/**
 * The owner's approval text for a batch (≤ 500 chars): every job with its old → new time (and
 * the forecast reason), what's left as is, and the exact text each customer gets. Lines that
 * don't fit are dropped from the batch itself (`included`), so "Y" only ever moves what was shown.
 * PURE.
 */
export function buildMoveSummary(input: {
  flavour: MoveFlavour;
  headline: string;
  moves: PlannedMove[];
  leftAsIs: string[];
  businessName: string;
  timeZone: string;
  max?: number;
}): { summary: string; included: PlannedMove[] } {
  const max = input.max ?? 500;
  const sample = (moves: PlannedMove[]) =>
    moves.length
      ? ` Each customer gets: "${movedCustomerText({ flavour: input.flavour, businessName: input.businessName, move: moves[0], timeZone: input.timeZone, link: LINK_PLACEHOLDER })}"`
      : "";
  const left = input.leftAsIs.length ? ` No open time for: ${input.leftAsIs.join(", ")} (left as is).` : "";
  for (let n = input.moves.length; n >= 1; n--) {
    const included = input.moves.slice(0, n);
    const dropped = input.moves.length - n;
    const lines = included.map((m) => moveLine(m, input.timeZone)).join("; ");
    const more = dropped ? ` (${dropped} more not included - ask me again after.)` : "";
    const text = `${input.headline} ${lines}.${more}${left}${sample(included)}`;
    if (text.length <= max) return { summary: text, included };
  }
  // Even one job with the sample doesn't fit: drop the sample's tail rather than the job.
  const one = input.moves.slice(0, 1);
  const text = `${input.headline} ${one.map((m) => moveLine(m, input.timeZone)).join("")}.${sample(one)}`;
  return { summary: text.slice(0, max), included: one };
}

function readMoves(payload: Record<string, unknown>): PlannedMove[] {
  const raw = Array.isArray(payload.moves) ? payload.moves : [];
  return raw.filter((m): m is PlannedMove => {
    const x = m as Record<string, unknown>;
    return typeof x?.bookingId === "string" && typeof x.toStartsAt === "string" && typeof x.fromStartsAt === "string";
  });
}

/** Claim the vacated slot so the gap filler doesn't offer a slot the owner just moved a job out of. */
export async function markSlotHandled(admin: AdminClient, company: Pick<DispatchCompany, "organizationId" | "companyId">, bookingId: string, fromStartsAt: string, reason: string): Promise<void> {
  const { error } = await (admin as Db).from("dispatch_runs").insert({
    organization_id: company.organizationId,
    company_id: company.companyId,
    kind: "fill_gap",
    run_key: gapRunKey(bookingId, fromStartsAt),
    status: "skipped",
    detail: { reason },
  });
  if (error && (error as { code?: string }).code !== "23505") console.error("[dispatcher] marking a moved slot failed", bookingId, error.message);
}

export function gapRunKey(bookingId: string, startsAt: string): string {
  const ms = Date.parse(startsAt);
  return `${bookingId}:${Number.isFinite(ms) ? new Date(ms).toISOString() : startsAt}`;
}

/** Run an approved batch of moves. */
export async function applyMoves(admin: AdminClient, approval: OwnerApprovalRow, decision: ApprovalDecision, flavour: MoveFlavour, nowMs = Date.now()): Promise<ExecuteResult> {
  if (!decision.approved) {
    return { ok: true, message: decision.decidedVia === "expiry" ? "That expired before you answered - nothing was moved." : "OK, nothing moved." };
  }
  if (decision.ownerNote?.trim()) {
    return { ok: false, message: `Nothing moved - #${approval.short_code ?? "?"} doesn't take an amount. Ask me again and reply just Y to move them.` };
  }
  const company = await loadDispatchCompany(admin, approval.organization_id, approval.company_id);
  if (!company) return { ok: false, message: "I couldn't find that business." };
  const moves = readMoves(approval.payload);
  if (moves.length === 0) return { ok: false, message: "There was nothing to move." };

  const db = admin as Db;
  const slots = await loadSlotContext(admin, company, nowMs);
  const ctx = ctxFor(admin, company.organizationId);
  const moved: PlannedMove[] = [];
  const skipped: string[] = [];
  const texts: SendOutcome[] = [];

  for (const move of moves) {
    const { data } = await db
      .from("bookings")
      .select("*")
      .eq("organization_id", company.organizationId)
      .eq("company_id", company.companyId)
      .eq("id", move.bookingId)
      .maybeSingle();
    const booking = data as Tables<"bookings"> | null;
    if (!booking || booking.status === "cancelled" || booking.status === "completed" || booking.status === "no_show") {
      skipped.push(`${move.who} (cancelled or done)`);
      continue;
    }
    const alreadyMoved = Date.parse(booking.scheduled_for) === Date.parse(move.toStartsAt);
    if (!alreadyMoved) {
      if (Date.parse(booking.scheduled_for) !== Date.parse(move.fromStartsAt)) {
        skipped.push(`${move.who} (already moved)`);
        continue;
      }
      if (booking.en_route_at || booking.started_at) {
        skipped.push(`${move.who} (crew already out)`);
        continue;
      }
      const slot = slotStillOpen(slots, { id: booking.id, durationMinutes: booking.duration_minutes, scheduledFor: booking.scheduled_for }, move.toStartsAt, move.toWindowKey, nowMs);
      if (!slot) {
        skipped.push(`${move.who} (${shortLabel(move.toStartsAt, company.timeZone)} got taken)`);
        continue;
      }
      await markSlotHandled(admin, company, booking.id, booking.scheduled_for, flavour === "weather" ? "weather_move" : "bulk_move");
      await rescheduleBooking(ctx, { bookingId: booking.id, scheduledFor: slot.startsAt, ...(slot.windowKey ? { windowKey: slot.windowKey } : {}) });
      const cal = slots.bookings.find((b) => b.id === booking.id);
      if (cal) {
        cal.scheduledFor = slot.startsAt;
        cal.windowKey = slot.windowKey;
      }
    }
    moved.push(move);
    if (move.contactId) {
      const body = movedCustomerText({ flavour, businessName: company.businessName, move, timeZone: company.timeZone, link: manageUrl(company, booking.manage_token) });
      texts.push(
        await sendOrQueue(
          admin,
          company,
          {
            kind: "job_moved",
            dedupeKey: `${approval.id}:${booking.id}`,
            to: null,
            body,
            audience: "customer",
            consent: false,
            bookingId: booking.id,
            contactId: move.contactId,
            approvalId: approval.id,
            expiresAt: new Date(move.toStartsAt),
          },
          nowMs,
        ),
      );
    }
  }

  if (moved.length === 0) return { ok: false, message: `Nothing moved: ${skipped.join("; ")}.`, detail: { skipped } };
  const list = moved.map((m) => `${m.who} to ${shortLabel(m.toStartsAt, company.timeZone)}`).join(", ");
  const queued = texts.includes("queued");
  const textLine = texts.length === 0 ? "" : queued ? ` Customers get their text at ${timeLabel(nextOpen(company, nowMs), company.timeZone)}.` : " Customers texted.";
  const skippedLine = skipped.length ? ` Left as is: ${skipped.join("; ")}.` : "";
  return {
    ok: true,
    message: `Moved ${moved.length} job${moved.length === 1 ? "" : "s"}: ${list}.${textLine}${skippedLine}`,
    detail: { moved: moved.map((m) => m.bookingId), skipped, texts },
  };
}

/** The next customer-hours opening (when queued texts go out). */
function nextOpen(company: DispatchCompany, nowMs: number): Date {
  return nextLocalTime(nowMs, company.timeZone, company.settings.customerHours.from);
}
