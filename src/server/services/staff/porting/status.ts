/**
 * The port request status machine and the owner's text for each status (pure). Owner texts never
 * carry the account number or PIN: only the number(s) being moved, dates and what to do next.
 */
import { prettyPhone } from "@/lib/carrier-forwarding";
import type { NumberPortRow, PortStatus } from "@/server/services/staff/porting/db-types";

/** Allowed moves. A status → itself is an update in place (re-signed form, a new FOC date). */
export const PORT_TRANSITIONS: Record<PortStatus, PortStatus[]> = {
  collecting: ["ready", "cancelled"],
  ready: ["ready", "submitted", "rejected", "cancelled"],
  submitted: ["foc_scheduled", "rejected", "completed", "cancelled"],
  foc_scheduled: ["foc_scheduled", "rejected", "completed", "cancelled"],
  rejected: ["ready", "cancelled"],
  completed: [],
  cancelled: [],
};

export const OPEN_STATUSES: PortStatus[] = ["collecting", "ready", "submitted", "foc_scheduled", "rejected"];
/** The owner may (re)fill the form in these. */
export const EDITABLE_STATUSES: PortStatus[] = ["collecting", "ready", "rejected"];
/** The owner may cancel from Settings in these (after submitting, an operator cancels at Twilio). */
export const OWNER_CANCELLABLE: PortStatus[] = ["collecting", "ready", "rejected"];
/** The completion sweep watches these. */
export const IN_FLIGHT: PortStatus[] = ["submitted", "foc_scheduled"];

export function fromStatusesFor(to: PortStatus): PortStatus[] {
  return (Object.keys(PORT_TRANSITIONS) as PortStatus[]).filter((from) => PORT_TRANSITIONS[from].includes(to));
}

export function canTransition(from: PortStatus, to: PortStatus): boolean {
  return PORT_TRANSITIONS[from].includes(to);
}

export const STATUS_LABELS: Record<PortStatus, string> = {
  collecting: "Waiting for your details",
  ready: "Details in - being sent to the carrier",
  submitted: "Sent to the carrier",
  foc_scheduled: "Move date set",
  completed: "Done",
  rejected: "Needs a fix",
  cancelled: "Cancelled",
};

export function numbersText(numbers: string[]): string {
  const pretty = numbers.map((n) => prettyPhone(n));
  if (pretty.length === 0) return "your number";
  if (pretty.length === 1) return pretty[0];
  return `${pretty.slice(0, -1).join(", ")} and ${pretty[pretty.length - 1]}`;
}

/** "Thu Oct 15" for a YYYY-MM-DD date (a calendar date, no time zone shift). */
export function focDateText(date: string | null): string {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return "the scheduled day";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export const CARRIER_APPROVAL_WARNING =
  "Your carrier may text you asking to approve the transfer: answer YES within 90 minutes or it gets rejected.";
export const KEEP_SERVICE_WARNING = "Don't cancel your old phone service - the move ends it for you.";

export interface OwnerTextContext {
  /** The /port/:token link (collecting, rejected). */
  link: string;
  ringEnabled: boolean;
  ringSeconds: number;
  /** Who picks up when nobody does: the AI (call answering on) or voicemail + a text back. */
  answering: "ai" | "voicemail";
}

/** The owner's text when a port reaches `status`, or null for none. */
export function ownerStatusText(port: Pick<NumberPortRow, "numbers" | "foc_date" | "rejection_reason">, status: PortStatus, ctx: OwnerTextContext): string | null {
  const nums = numbersText(port.numbers);
  switch (status) {
    case "collecting":
      return `Keep your number: to move ${nums} over we need a few details (about 5 minutes - have a recent phone bill handy): ${ctx.link} Your calls keep working the whole time.`;
    case "ready":
      return `Got it - everything's in for moving ${nums}. We'll send it to your carrier within 1 business day and text you when it's in.`;
    case "submitted":
      return `Your number move for ${nums} is in with the carrier (usually 5-7 business days). ${KEEP_SERVICE_WARNING} ${CARRIER_APPROVAL_WARNING}`;
    case "foc_scheduled":
      return `${nums} moves over on ${focDateText(port.foc_date)}. Keep your old service until then - calls work the whole time. ${CARRIER_APPROVAL_WARNING}`;
    case "rejected": {
      const reason = (port.rejection_reason ?? "").trim().replace(/\s+/g, " ").slice(0, 200) || "the details didn't match the carrier's records";
      return `Your carrier sent back the move for ${nums}: ${reason}. Fix it here and we'll send it again: ${ctx.link}`;
    }
    case "completed": {
      const fallback = ctx.answering === "ai" ? "your AI answers" : "they get your voicemail and a text back";
      const routing = ctx.ringEnabled
        ? `Calls ring your cell first for ${ctx.ringSeconds} seconds (press 1 to take one), then ${fallback}.`
        : `Calls go straight to ${ctx.answering === "ai" ? "your AI" : "voicemail, with a text back"}.`;
      return `Done: ${nums} now rings through us. ${routing} You can turn call forwarding off now - it isn't needed any more.`;
    }
    case "cancelled":
      return `Your number move for ${nums} was cancelled. Nothing changes: your phone works as before.`;
    default:
      return null;
  }
}

/** The next step in plain words (owner tool, Settings). */
export function nextStepText(status: PortStatus): string {
  switch (status) {
    case "collecting":
      return "Fill in the form at the link (carrier, account number, a recent phone bill, and sign).";
    case "ready":
      return "Nothing for you to do: we send it to the carrier within 1 business day.";
    case "submitted":
      return `Nothing to do but wait (5-7 business days). ${KEEP_SERVICE_WARNING} ${CARRIER_APPROVAL_WARNING}`;
    case "foc_scheduled":
      return `Keep your old service until the move date. ${CARRIER_APPROVAL_WARNING}`;
    case "rejected":
      return "Fix what the carrier flagged at the link and it goes back in.";
    case "completed":
      return "Done. You can turn call forwarding off.";
    case "cancelled":
      return "Nothing - it was cancelled.";
  }
}
