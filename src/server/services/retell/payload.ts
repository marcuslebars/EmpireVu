/**
 * Defensive readers for Retell webhook payloads.
 *
 * The webhook envelope (`event` + `call`) and the standard call fields are known,
 * but `call.call_analysis.custom_analysis_data` is populated by the dashboard-defined
 * post-call analysis schema and by an LLM, so nothing here assumes a value's presence
 * or type: every field is probed across plausible names and any miss returns null
 * rather than throwing. Pure functions — no I/O — so they're fully unit tested.
 *
 * This module is deliberately self-contained (it does NOT import the Telnyx helpers),
 * because Retell replaces the Telnyx/Cartesia voice path and must outlive it.
 */

type AsRecord = Record<string, unknown>;

export function asRecord(value: unknown): AsRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AsRecord) : null;
}

/** Read a dotted path ("call.call_analysis.custom_analysis_data") without throwing. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function firstString(source: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Digits-only last-10, matching lead-intake/matching.ts exactly (including returning
 * null below 10 digits) so Retell lookups and web-form dedup agree.
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

/** Read the first present string field from any of the given paths. */
export function readString(payload: unknown, paths: readonly string[]): string | null {
  return firstString(payload, paths);
}

/** Read a string array, tolerating a single string or a comma-joined string. */
export function readStringArray(payload: unknown, paths: readonly string[]): string[] {
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

/** Read a number that may arrive as a string ("24", "24 ft", "$340.00"). */
export function readNumber(payload: unknown, paths: readonly string[]): number | null {
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

/** Read a loose boolean ("yes"/"true"/true/1 → true; "no"/"false"/0 → false). */
export function readBoolean(payload: unknown, paths: readonly string[]): boolean | null {
  for (const path of paths) {
    const coerced = coerceBoolean(readPath(payload, path));
    if (coerced !== null) return coerced;
  }
  return null;
}

/** First present (non-null/undefined, non-empty-string) RAW value across paths. */
export function readFirst(source: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    const v = readPath(source, path);
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return undefined;
}

/**
 * Boat length from whatever the model sends: 24, "24", "24 feet", "24ft", "about 24'".
 * Returns null when there's no plausible positive number.
 */
export function coerceBoatLengthFt(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Engine count as a small non-negative integer ("twin" → 2, "single" → 1). */
export function coerceEngineCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.min(20, Math.round(value)) : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (/\b(single|one)\b/.test(normalized)) return 1;
  if (/\b(twin|dual|two)\b/.test(normalized)) return 2;
  if (/\b(triple|three)\b/.test(normalized)) return 3;
  if (/\b(quad|four)\b/.test(normalized)) return 4;
  const match = normalized.match(/\d+/);
  if (!match) return null;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(20, parsed) : null;
}

/** Free-text engine type → the canonical outboard | sterndrive | inboard. */
export function coerceEngineType(value: unknown): "outboard" | "sterndrive" | "inboard" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  // Sterndrive/IO MUST be checked first: "inboard/outboard" contains both other
  // keywords, so checking "outboard" first would misclassify an I/O.
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

/** Coerce loose truthiness ("yes", "true", true, 1). Returns null when undecidable. */
export function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "urgent", "asap"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "none"].includes(normalized)) return false;
  return null;
}
