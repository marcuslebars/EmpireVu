/**
 * Owner notes on an approval ("Y but $700"), read conservatively. PURE — shared by the owner
 * channel's reply parser (is this a price?) and the executor (what price?).
 */
export type ParsedNote =
  | { kind: "none" }
  | { kind: "price"; cents: number }
  | { kind: "ambiguous"; why: string }
  | { kind: "text"; text: string };

const FILLER = /\b(y|yes|yep|ok|okay|sure|but|make it|do|at|for|price|total|charge|it's|its|it|is|send|quote|them|the|go with|plus|hst|tax|before|pre|please|pls|instead)\b/gi;

/**
 * PURE. "$700" / "700" / "but $1,200.50 + HST" → a price in cents (before HST). Several numbers,
 * rates ("/hr", "per"), percentages, "incl tax", or a non-price instruction → ambiguous.
 */
export function parseOwnerNote(note: string | null | undefined): ParsedNote {
  const text = (note ?? "").trim();
  if (!text) return { kind: "none" };
  const numbers = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (/%|percent|\bper\b|\/\s?(hr|hour|h|ft|sq|visit|month|mo)\b|an hour|hourly|\bincl|including|includes|tax in|\bor\b|\d\s?-\s?\$?\d|\bto\s+\$?\d|between|range|approx|about|around|~/i.test(text)) {
    return numbers.length ? { kind: "ambiguous", why: "it isn't one clear price" } : { kind: "text", text };
  }
  if (numbers.length === 0) return { kind: "text", text };
  if (numbers.length > 1) return { kind: "ambiguous", why: "it has more than one number" };
  const leftover = text
    .replace(/\$?\s?\d[\d,]*(?:\.\d+)?\s?(k\b)?/i, " ")
    .replace(FILLER, " ")
    .replace(/[.,!:;$+-]/g, " ")
    .trim();
  if (leftover) return { kind: "ambiguous", why: `I'm not sure what "${text}" means` };
  const raw = (numbers[0] ?? "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { kind: "ambiguous", why: "the amount looks off" };
  let cents = Math.round(Number(raw) * 100);
  if (/\d\s?k\b/i.test(text)) cents *= 1000;
  if (!Number.isFinite(cents) || cents < 100 || cents > 100_000_000) return { kind: "ambiguous", why: "the amount looks off" };
  return { kind: "price", cents };
}

