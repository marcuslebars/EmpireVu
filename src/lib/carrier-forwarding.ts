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
      "Within seconds the calling phone gets a text from you, and the call shows up in your Inbox.",
    ],
  };
}

// ── One-tap forwarding plan (done-for-you, docs/done-for-you.md → "Automatic switch-on") ──
//
// Picks HOW the owner turns forwarding on from what the quick setup recorded about their
// business line (companies.business_phone_kind + business_phone_carrier):
//   • cell → one GSM "all conditional forwarding" code, **004*<number>#, dialled from the
//     business phone itself (Android: a tel: link; iPhone: copy + paste into the Phone app —
//     iOS refuses tel: links that contain * or #). Individual **61/**67/**62 codes are the
//     fallback if a carrier rejects **004.
//   • landline / VoIP → no codes we can trust across providers: the provider (or its web
//     portal) sets "forward on busy + no answer"; we give the exact words to ask for, plus
//     "Have us set it up".
// Confidence: "confident" = the GSM codes are standard and long supported on that network;
// "verify" = expected to work (3GPP network) but not yet confirmed on a real phone — see the
// table in docs/done-for-you.md. Never forward ALL calls (unconditional): the owner's phone
// would stop ringing.

export type BusinessPhoneKind = "cell" | "landline" | "voip";

export type ForwardingConfidence = "confident" | "verify";

interface CarrierEntry {
  label: string;
  /** Mobile network the brand runs on (for docs / support). */
  network: string;
  confidence: ForwardingConfidence;
}

/** Canadian mobile brands (key = companies.business_phone_carrier, lower-case). */
export const CELL_CARRIERS: Record<string, CarrierEntry> = {
  rogers: { label: "Rogers", network: "Rogers", confidence: "confident" },
  fido: { label: "Fido", network: "Rogers", confidence: "confident" },
  chatr: { label: "chatr", network: "Rogers", confidence: "confident" },
  freedom: { label: "Freedom Mobile", network: "Freedom", confidence: "confident" },
  bell: { label: "Bell", network: "Bell", confidence: "verify" },
  virgin: { label: "Virgin Plus", network: "Bell", confidence: "verify" },
  lucky: { label: "Lucky Mobile", network: "Bell", confidence: "verify" },
  telus: { label: "TELUS", network: "TELUS", confidence: "verify" },
  koodo: { label: "Koodo", network: "TELUS", confidence: "verify" },
  public: { label: "Public Mobile", network: "TELUS", confidence: "verify" },
  videotron: { label: "Videotron", network: "Videotron", confidence: "verify" },
};

/** Landline / VoIP providers we name in the instructions (anything else → "your provider"). */
const LINE_PROVIDERS: Record<string, string> = {
  bell: "Bell",
  rogers: "Rogers",
  telus: "TELUS",
  videotron: "Videotron",
  cogeco: "Cogeco",
  shaw: "Shaw",
  eastlink: "Eastlink",
  vonage: "Vonage",
  ooma: "Ooma",
  ringcentral: "RingCentral",
  fongo: "Fongo",
};

const CARRIER_ALIASES: Record<string, string> = {
  "virgin plus": "virgin",
  "virgin mobile": "virgin",
  "freedom mobile": "freedom",
  "lucky mobile": "lucky",
  "public mobile": "public",
  "vidéotron": "videotron",
  "bell mobility": "bell",
  "telus mobility": "telus",
  "rogers wireless": "rogers",
  "ring central": "ringcentral",
};

/** "Virgin Plus" / "VIRGIN" / "virgin_plus" → "virgin"; null when blank. */
export function normalizeCarrier(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!value) return null;
  if (CARRIER_ALIASES[value]) return CARRIER_ALIASES[value];
  const first = value.split(" ")[0];
  if (CELL_CARRIERS[value] || LINE_PROVIDERS[value]) return value;
  if (CELL_CARRIERS[first] || LINE_PROVIDERS[first]) return first;
  return value === "other" || value === "unknown" || value === "not sure" ? null : value;
}

export function isBusinessPhoneKind(value: unknown): value is BusinessPhoneKind {
  return value === "cell" || value === "landline" || value === "voip";
}

export interface ForwardingPlanInput {
  /** The number calls forward TO (catcher or AI receptionist), any NANP format. */
  forwardTo: string;
  kind: string | null | undefined;
  carrier: string | null | undefined;
}

export interface ForwardingPlan {
  /** Normalised kind; "unknown" when the quick setup didn't say (treated like a cell). */
  kind: BusinessPhoneKind | "unknown";
  carrierKey: string | null;
  carrierLabel: string | null;
  /** dial_code: the owner dials one code from the business phone. provider: their provider sets it. */
  method: "dial_code" | "provider";
  number: string;
  pretty: string;
  /** dial_code only: **004*+1NNNNNNNNNN# */
  code: string | null;
  /** dial_code only: ##004# */
  deactivate: string | null;
  /** dial_code only: tel: link with # encoded as %23 (Android; iOS refuses * and # in tel: links). */
  telHref: string | null;
  confidence: ForwardingConfidence | null;
  /** dial_code only: the individual codes if the carrier rejects **004. */
  fallbackCodes: ForwardingCode[];
  /** Short owner-facing steps for this kind/carrier. */
  steps: string[];
  /** What to say to the provider (always present — also the fallback for a rejected code). */
  providerScript: string;
}

/** tel: href for an MMI code. `#` must be percent-encoded or the browser treats it as a fragment. */
export function telHrefForCode(code: string): string {
  return `tel:${code.replace(/#/g, "%23")}`;
}

/** PURE. How this business turns on forwarding to `forwardTo`. Golden-tested per carrier/kind. */
export function forwardingPlan(input: ForwardingPlanInput): ForwardingPlan {
  const instructions = buildForwardingInstructions(input.forwardTo);
  const kind: ForwardingPlan["kind"] = isBusinessPhoneKind(input.kind) ? input.kind : "unknown";
  const carrierKey = normalizeCarrier(input.carrier);
  const providerScript =
    `Call your phone provider and ask them to forward unanswered and busy calls to ${instructions.pretty} ` +
    `("call forward no answer" and "call forward busy", after about 4–5 rings). Don't forward ALL calls.`;

  if (kind === "landline" || kind === "voip") {
    const provider = carrierKey ? LINE_PROVIDERS[carrierKey] ?? CELL_CARRIERS[carrierKey]?.label ?? null : null;
    const who = provider ?? "your phone provider";
    const steps =
      kind === "voip"
        ? [
            `Log in to ${provider ? `your ${provider} account` : "your phone system's website or app"} and find "call forwarding" (sometimes "call handling" or "find me / follow me").`,
            `Forward unanswered and busy calls to ${instructions.pretty} after 4–5 rings. Leave your phone ringing first — don't forward ALL calls.`,
            `Can't find it? Call ${who} and ask for "call forward no answer" and "call forward busy" to ${instructions.pretty}.`,
          ]
        : [
            `Call ${who} from any phone.`,
            `Ask them to turn on "call forward no answer" and "call forward busy" to ${instructions.pretty}, after 4–5 rings.`,
            "Don't let them forward ALL calls — your phone should still ring first.",
          ];
    return {
      kind,
      carrierKey,
      carrierLabel: provider,
      method: "provider",
      number: instructions.number,
      pretty: instructions.pretty,
      code: null,
      deactivate: null,
      telHref: null,
      confidence: null,
      fallbackCodes: [],
      steps,
      providerScript,
    };
  }

  // Cell (or unknown → the cell path, the common case for small trades; the provider script
  // is always shown as the fallback).
  const carrier = carrierKey ? CELL_CARRIERS[carrierKey] ?? null : null;
  const code = instructions.recommended.activate;
  return {
    kind,
    carrierKey: carrier ? carrierKey : null,
    carrierLabel: carrier?.label ?? null,
    method: "dial_code",
    number: instructions.number,
    pretty: instructions.pretty,
    code,
    deactivate: instructions.recommended.deactivate,
    telHref: telHrefForCode(code),
    confidence: carrier?.confidence ?? "verify",
    fallbackCodes: instructions.codes,
    steps: [
      "Use the phone your customers call (your business cell).",
      `Dial ${code} and press Call. You'll see a short "forwarding activated" message.`,
      "That's it — your phone still rings first; only calls you miss or can't take are forwarded.",
    ],
    providerScript,
  };
}
