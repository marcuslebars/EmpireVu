/**
 * Marina's phone quote — the `quote_shrink_wrap` tool, now served by EmpireVu.
 *
 * Replaces a1marinecare/src/lib/retell/phone-quote.ts. The argument contract is kept
 * IDENTICAL (name, phone, email, boat_length_ft, hull_type, winterization_engine,
 * engine_count, boat_location, town, notes) so cutting the Retell agent over is a URL +
 * header change, not a prompt rewrite. What changed underneath:
 *
 *   • The tenant is resolved from the CALL (dialled number → agent id), never from args,
 *     so the same tool serves every company with a Marina number.
 *   • Prices come from that company's service catalog (no hard-coded rate card). A1
 *     Marine Care's catalog is seeded to reproduce the Care site's calculator to the cent
 *     — see supabase/seeds/a1-care-shrink-wrap.sql and the golden test.
 *   • The lead goes through the same durable phone-lead intake as every Retell call
 *     (idempotent on call_id), and the quote is a real EmpireVu quote: numbered, on the
 *     hosted /q page, payable through the company's own Stripe account.
 *
 * Nothing here invents a price. Missing inputs come back as `missing_info` (Marina asks),
 * boats outside the auto-quote range come back as `manual_review` (the owner quotes it),
 * and a company without a catalog comes back `unsupported` (callback).
 */
import type { ServiceCatalog } from "@/server/services/quotes/catalog";
import type { QuotePricedLineItem } from "@/server/services/quotes/pricing";
import type { RetellCallContext } from "../functions";

export type EngineType = "outboard" | "sterndrive" | "inboard";

/** The tool's arguments, exactly as the Retell function schema defines them. */
export interface PhoneQuoteArgs {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  boat_length_ft?: unknown;
  hull_type?: unknown;
  winterization_engine?: unknown;
  engine_count?: unknown;
  boat_location?: unknown;
  town?: unknown;
  notes?: unknown;
  /** Optional: which catalog service to quote. Defaults to shrink_wrap (Marina's season). */
  service?: unknown;
}

/** Below this, a length is a mishearing or a dinghy — either way a human looks at it. */
export const MIN_AUTO_QUOTE_LENGTH_FT = 8;
export const DEFAULT_PHONE_SERVICE = "shrink_wrap";
const MAX_ENGINES = 4;

// ── Parsing what a caller says (ported verbatim from the Care site) ─────────────

const HULLS: Record<string, string> = {
  bowrider: "bowrider",
  runabout: "bowrider",
  "bow rider": "bowrider",
  deckboat: "bowrider",
  "deck boat": "bowrider",
  cuddy: "cuddy",
  "cuddy cabin": "cuddy",
  cruiser: "cruiser",
  "express cruiser": "cruiser",
  yacht: "cruiser",
  pontoon: "pontoon",
  tritoon: "tritoon",
  "tri-toon": "tritoon",
  sailboat: "sailboat",
  sail: "sailboat",
  pwc: "pwc",
  "sea-doo": "pwc",
  seadoo: "pwc",
  "sea doo": "pwc",
  jetski: "pwc",
  "jet ski": "pwc",
  waverunner: "pwc",
  other: "other",
  fishing: "other",
  "fishing boat": "other",
  "bass boat": "other",
  "center console": "other",
  aluminum: "other",
};

export function parseHullType(value: unknown): string {
  if (typeof value !== "string") return "other";
  const v = value.trim().toLowerCase();
  if (HULLS[v]) return HULLS[v];
  for (const [key, hull] of Object.entries(HULLS)) {
    if (v.includes(key)) return hull;
  }
  return "other";
}

export function parseEngineType(value: unknown): EngineType | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v === "none" || v === "no") return null;
  if (v.includes("outboard")) return "outboard";
  if (
    v.includes("stern") ||
    v.includes("i/o") ||
    v === "io" ||
    v.includes("inboard/outboard") ||
    v.includes("mercruiser") ||
    v.includes("volvo")
  ) {
    return "sterndrive";
  }
  if (v.includes("inboard") || v.includes("v-drive") || v.includes("direct drive")) return "inboard";
  return null;
}

/** "24", 24.4, "twenty-four foot… 24ft" → whole feet, as the Care site did. */
export function parseLengthFt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string") {
    const m = value.match(/(\d{1,3})(?:\.\d+)?/);
    if (m) return Number(m[1]);
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseEmail(value: unknown): string | null {
  const v = text(value);
  return v && /^\S+@\S+\.\S+$/.test(v) ? v : null;
}

// ── The plan: args + catalog → what to price (PURE) ─────────────────────────────

export interface PlannedService {
  serviceId: string;
  lengthFt?: number;
  engineCount?: number;
}

export type PhoneQuotePlan =
  | { status: "missing_info"; missing: string[] }
  | { status: "unsupported"; reason: string }
  | { status: "manual_review"; reasons: string[]; lengthFt: number; hullType: string }
  | {
      status: "ready";
      services: PlannedService[];
      hullType: string;
      lengthFt: number;
      primaryLabel: string;
      winterization: { engineType: EngineType; engineCount: number } | null;
    };

export function planPhoneQuote(
  args: PhoneQuoteArgs,
  catalog: ServiceCatalog | null,
  callerPhone: string | null,
): PhoneQuotePlan {
  const name = text(args.name) ?? "";
  const lengthFt = parseLengthFt(args.boat_length_ft);
  const phone = text(args.phone) ?? callerPhone;

  const missing: string[] = [];
  if (name.length < 2) missing.push("name");
  if (!lengthFt) missing.push("boat_length_ft");
  if (!phone) missing.push("phone");
  if (missing.length > 0) return { status: "missing_info", missing };

  if (!catalog) return { status: "unsupported", reason: "Pricing isn't set up for this line yet." };

  const serviceKey = (text(args.service) ?? DEFAULT_PHONE_SERVICE).toLowerCase().replace(/[\s-]+/g, "_");
  const item = catalog.items[serviceKey];
  if (!item) return { status: "unsupported", reason: `This line doesn't quote "${serviceKey}" by phone.` };

  const hullType = parseHullType(args.hull_type);
  const reasons: string[] = [];
  if (lengthFt! < MIN_AUTO_QUOTE_LENGTH_FT) reasons.push(`Boat length under ${MIN_AUTO_QUOTE_LENGTH_FT} ft`);
  if (item.maxMeasure != null && lengthFt! > item.maxMeasure) {
    reasons.push(`Boats over ${item.maxMeasure} ft are quoted individually`);
  }
  if (reasons.length > 0) return { status: "manual_review", reasons, lengthFt: lengthFt!, hullType };

  const services: PlannedService[] = [{ serviceId: serviceKey, lengthFt: lengthFt! }];

  const engineType = parseEngineType(args.winterization_engine);
  let winterization: { engineType: EngineType; engineCount: number } | null = null;
  if (engineType) {
    const winterKey = `winterization_${engineType}`;
    if (catalog.items[winterKey]) {
      const engineCount = Math.max(1, Math.min(MAX_ENGINES, parseLengthFt(args.engine_count) ?? 1));
      services.push({ serviceId: winterKey, engineCount });
      winterization = { engineType, engineCount };
    }
    // A company that doesn't winterize simply isn't quoted for it; the wrap still is.
  }

  return { status: "ready", services, hullType, lengthFt: lengthFt!, primaryLabel: item.label, winterization };
}

// ── What Marina says (PURE) ─────────────────────────────────────────────────────

/** "$672", "$481.25" — never "$672.00". No thousands separator: TTS reads it cleanly. */
export function spokenDollars(cents: number): string {
  const dollars = Math.round(cents) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** "Mobile shrink wrap" → "shrink wrap": the word a caller uses, not the catalog label. */
function spokenService(label: string): string {
  return label.replace(/^mobile\s+/i, "").split(/\s+[—-]\s+/)[0].toLowerCase();
}

export function phoneQuoteSummary(input: {
  plan: Extract<PhoneQuotePlan, { status: "ready" }>;
  lineItems: Pick<QuotePricedLineItem, "serviceId" | "amountCents" | "selected">[];
  subtotalCents: number;
  depositCents: number;
  depositIsFlat: boolean;
}): string {
  const { plan, lineItems } = input;
  const primaryKey = plan.services[0].serviceId;
  const primary = lineItems.find((l) => l.serviceId === primaryKey && l.selected);
  const others = lineItems.filter((l) => l.serviceId !== primaryKey && l.selected);

  const boat = `${plan.lengthFt}-foot ${plan.hullType === "other" ? "boat" : plan.hullType}`;
  const parts: string[] = [];
  if (primary) {
    parts.push(`The ${spokenService(plan.primaryLabel)} for a ${boat} comes to ${spokenDollars(primary.amountCents)}`);
  }
  for (const line of others) {
    const what = line.serviceId.startsWith("winterization_") ? "winterization" : line.serviceId.replace(/_/g, " ");
    parts.push(`${what} is ${spokenDollars(line.amountCents)}`);
  }

  const deposit = input.depositIsFlat
    ? `A ${spokenDollars(input.depositCents)} deposit holds your date and comes straight off that.`
    : `A ${spokenDollars(input.depositCents)} deposit holds your date.`;

  return `${parts.join(", and ")}. That's ${spokenDollars(input.subtotalCents)} all in, plus HST. ${deposit}`;
}

export function manualReviewSummary(reasons: string[]): string {
  return `That one's outside what I can price on the phone (${reasons.join("; ")}), so the owner will quote it personally.`;
}

export function missingInfoSummary(missing: string[]): string {
  return `I still need the caller's ${missing.join(" and ").replace(/_/g, " ")} before I can price it.`;
}

// ── The lead Marina files alongside the quote ───────────────────────────────────

/**
 * Re-shape the tool call into the capture-lead payload the phone-lead intake already
 * understands, so a quote call is filed exactly like any other Retell lead (same
 * dedup, same owner notification, same retell_calls row — idempotent on call_id).
 */
export function toCaptureLeadPayload(
  args: PhoneQuoteArgs,
  call: RetellCallContext,
  rawCall: unknown,
  plan: PhoneQuotePlan,
): Record<string, unknown> {
  const location = [text(args.boat_location), text(args.town)].filter(Boolean).join(", ");
  const engineType = parseEngineType(args.winterization_engine);
  const services = [plan.status === "ready" ? plan.primaryLabel : text(args.service) ?? "Shrink wrap"];
  if (plan.status === "ready" && plan.winterization) services.push("Winterization");
  const altPhone = text(args.phone);
  const summaryBits = [
    "Quoted by Marina on the phone.",
    altPhone && altPhone !== call.fromNumber ? `Best number to text: ${altPhone}.` : null,
    text(args.notes),
  ].filter(Boolean);

  return {
    call: rawCall ?? {
      call_id: call.callId,
      from_number: call.fromNumber,
      to_number: call.toNumber,
      agent_id: call.agentId,
      direction: call.direction,
    },
    args: {
      caller_name: text(args.name),
      caller_email: parseEmail(args.email),
      boat_length_ft: parseLengthFt(args.boat_length_ft),
      boat_type: parseHullType(args.hull_type),
      ...(engineType ? { engine_type: engineType, engine_count: parseLengthFt(args.engine_count) ?? 1 } : {}),
      ...(location ? { boat_location: location } : {}),
      services_requested: services,
      summary: summaryBits.join(" "),
    },
  };
}
