/**
 * Carrier conditional-call-forwarding instructions for the missed-call catcher
 * (docs/missed-call-catcher.md). Pure — shared by the onboarding UI and the server
 * (the org API returns the same instructions), and golden-tested.
 *
 * GSM/LTE (MMI) codes are dialled from the BUSINESS phone itself. Most Canadian mobile
 * carriers (Rogers, Fido, Bell, Telus, Freedom, Koodo, Virgin) accept them, but plans vary —
 * the owner should confirm with their carrier. Landlines and VoIP systems don't use these
 * codes: the provider sets "call forward no answer / busy" on the account or in its portal.
 */

export type ForwardingCondition = "no_answer" | "busy" | "unreachable" | "all_conditional";

export interface ForwardingCode {
  condition: ForwardingCondition;
  label: string;
  /** What to dial to turn it on. */
  activate: string;
  /** What to dial to turn it off again. */
  deactivate: string;
}

export interface ForwardingInstructions {
  /** The catcher number as dialled in the codes (E.164, e.g. +17055551234). */
  number: string;
  /** Display form, e.g. (705) 555-1234. */
  pretty: string;
  /** Recommended single code: all conditional forwarding (no answer + busy + unreachable). */
  recommended: ForwardingCode;
  /** Individual codes, for carriers that don't support **004#. */
  codes: ForwardingCode[];
  /** Optional: no-answer forwarding with a ring time before it forwards (GSM **61*N**T#). */
  noAnswerWithRingTime: { seconds: number; activate: string };
  landline: string;
  verifyNote: string;
  testSteps: string[];
}

/** E.164-ish normalisation for display + dialling. NANP 10/11 digits → +1XXXXXXXXXX. */
export function toDialNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export function prettyPhone(raw: string): string {
  const e164 = toDialNumber(raw);
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const CODES: Array<{ condition: ForwardingCondition; label: string; mmi: string }> = [
  { condition: "no_answer", label: "When you don't answer", mmi: "61" },
  { condition: "busy", label: "When you're on another call", mmi: "67" },
  { condition: "unreachable", label: "When your phone is off or has no signal", mmi: "62" },
];

/** Allowed ring times for **61 (GSM): 5–30 s in steps of 5. */
function clampRingTime(seconds: number): number {
  const rounded = Math.round(seconds / 5) * 5;
  return Math.min(30, Math.max(5, Number.isFinite(rounded) ? rounded : 20));
}

export function buildForwardingInstructions(catcherNumber: string, ringSeconds = 20): ForwardingInstructions {
  const number = toDialNumber(catcherNumber);
  const pretty = prettyPhone(number);
  const codes: ForwardingCode[] = CODES.map((c) => ({
    condition: c.condition,
    label: c.label,
    activate: `**${c.mmi}*${number}#`,
    deactivate: `##${c.mmi}#`,
  }));
  return {
    number,
    pretty,
    recommended: {
      condition: "all_conditional",
      label: "All of the above in one code (no answer, busy, unreachable)",
      activate: `**004*${number}#`,
      deactivate: `##004#`,
    },
    codes,
    noAnswerWithRingTime: {
      seconds: clampRingTime(ringSeconds),
      activate: `**61*${number}**${clampRingTime(ringSeconds)}#`,
    },
    landline:
      `Landline or VoIP (office phone system): call your phone provider, or open its online portal, and ask them to ` +
      `set "call forward no answer" and "call forward busy" to ${pretty}. Ask for about 4–5 rings before it forwards.`,
    verifyNote:
      "These codes work on most mobile carriers, but plans differ — if a code is rejected, call your carrier and ask " +
      `for "conditional call forwarding" (no answer / busy / unreachable) to ${pretty}. Never forward ALL calls ` +
      "(unconditional) — then the phone would never ring for you.",
    // Manual alternative to the automatic "Test my forwarding" call (which needs nothing
    // from the owner but not answering) — docs/missed-call-catcher.md.
    testSteps: [
      "From a DIFFERENT phone (not the business line), call your business number.",
      "Don't answer — let it ring out (or decline it).",
      `The call forwards to ${pretty}: the caller hears your greeting and can leave a voicemail.`,
      "Within seconds the calling phone gets a text from you, and the call shows up in EmpireVu.",
    ],
  };
}
