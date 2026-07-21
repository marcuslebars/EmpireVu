/**
 * Defensive readers for Telnyx payloads.
 *
 * The exact request schemas are NOT confirmed yet (that's what
 * TELNYX_DEBUG_PAYLOADS exists for), so nothing here assumes a shape: every
 * value is probed across the plausible field names and any miss returns null
 * rather than throwing. Pure functions — no I/O — so they're fully unit tested.
 */

type AsRecord = Record<string, unknown>;

function asRecord(value: unknown): AsRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsRecord)
    : null;
}

/** Read a dotted path ("call.from") without throwing on missing intermediates. */
function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function firstString(source: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Digits-only last-10, matching lead-intake/matching.ts exactly (including
 * returning null below 10 digits) so Telnyx lookups and form dedup agree.
 */
export function normalizePhoneLast10(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** Best-effort E.164 for storage/display. Assumes NANP when no country code. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // SIP-style values arrive as `sip:+14155559876@host` or `tel:+1...`.
  const withoutScheme = trimmed.replace(/^(sips?|tel):/i, "").split("@")[0];
  const hasPlus = withoutScheme.startsWith("+");
  const digits = withoutScheme.replace(/\D/g, "");
  if (digits.length < 10) return null;
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** The caller's number (who dialled us). */
export function extractCallerNumber(payload: unknown): string | null {
  return firstString(payload, [
    "call.from",
    "telnyx_end_user_target",
    "from",
    "data.payload.from",
    "data.from",
    "payload.from",
    "caller_number",
    "call.caller_number",
  ]);
}

/** The number that was dialled (ours) — this decides the brand/tenant. */
export function extractCalledNumber(payload: unknown): string | null {
  return firstString(payload, [
    "call.to",
    "telnyx_agent_target",
    "to",
    "data.payload.to",
    "data.to",
    "payload.to",
    "called_number",
    "call.called_number",
  ]);
}

/** Stable id for a conversation — the idempotency key for endpoints 3 and 4. */
export function extractConversationId(payload: unknown): string | null {
  return firstString(payload, [
    "telnyx_conversation_id",
    "conversation_id",
    "data.conversation_id",
    "data.payload.conversation_id",
    "payload.conversation_id",
    "call.conversation_id",
    "metadata.telnyx_conversation_id",
  ]);
}

/**
 * Boat length from whatever the model sends: 24, "24", "24 feet", "24ft",
 * "about 24'", "24.5". Returns null when there's no plausible number, so the
 * caller can answer with `missing_info` instead of pricing a guess.
 */
export function coerceBoatLengthFt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Free-text engine type → the engine's EngineType union. */
export function coerceEngineType(value: unknown): "outboard" | "sterndrive" | "inboard" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  // Sterndrive/IO MUST be checked first: "inboard/outboard" contains both other
  // keywords, so checking "outboard" first would classify an I/O as an outboard
  // and quote the wrong winterization flat rate.
  if (
    normalized.includes("stern") ||
    normalized.includes("i/o") ||
    normalized.includes("inboard/outboard") ||
    normalized.includes("inboard outboard") ||
    normalized === "io"
  ) {
    return "sterndrive";
  }
  if (normalized.includes("outboard")) return "outboard";
  if (normalized.includes("inboard")) return "inboard";
  return null;
}

/** Coerce loose truthiness ("yes", "true", true, 1) for booked-style flags. */
export function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "booked"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  return null;
}

/** Read the first present string field from a flat-ish payload. */
export function readString(payload: unknown, paths: string[]): string | null {
  return firstString(payload, paths);
}

/** Read a string array, tolerating a single string or a comma-joined string. */
export function readStringArray(payload: unknown, paths: string[]): string[] {
  for (const path of paths) {
    const value = readPath(payload, path);
    if (Array.isArray(value)) {
      const items = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (items.length > 0) return items;
    }
    if (typeof value === "string" && value.trim()) {
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return [];
}

/** Read a number that may arrive as a string ("340", "$340.00"). */
export function readNumber(payload: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const value = readPath(payload, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      if (match) {
        const parsed = Number.parseFloat(match[0]);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}
