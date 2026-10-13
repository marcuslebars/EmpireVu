/**
 * Everdoer rebrand: the product line an organization is on, independent of the old brand names.
 *
 * organizations.platform_brand holds 'empirevu' (the standard product) or 'crankleads' (done for
 * you) today. Phase 3 (D4) renames the values to 'standard' / 'done_for_you'. Until then, and for
 * one release after, EVERY read goes through normalizeProductLine() and every query filter uses
 * PRODUCT_LINE_DB_VALUES, so the code works on both sides of that migration.
 *
 * Browser-safe and PURE.
 * Shim removal (PR 8): drop the old values from LEGACY_VALUES and PRODUCT_LINE_DB_VALUES once
 * the Phase 3 migration has run and the CHECK no longer allows them.
 */

export const PRODUCT_LINES = ["standard", "done_for_you"] as const;
export type ProductLine = (typeof PRODUCT_LINES)[number];

export const DEFAULT_PRODUCT_LINE: ProductLine = "standard";

/** Old stored value → product line. */
const LEGACY_VALUES: Record<string, ProductLine> = {
  empirevu: "standard",
  crankleads: "done_for_you",
};

/** Every value that may be stored for a product line (old and new), for `.in()` filters. */
export const PRODUCT_LINE_DB_VALUES: Record<ProductLine, readonly string[]> = {
  standard: ["empirevu", "standard"],
  done_for_you: ["crankleads", "done_for_you"],
};

/** True for any stored value we still understand (old or new). */
export function isKnownProductLineValue(value: unknown): value is string {
  return typeof value === "string" && (value in LEGACY_VALUES || (PRODUCT_LINES as readonly string[]).includes(value));
}

/** True for an old (pre-Phase 3) stored value. */
export function isLegacyProductLineValue(value: unknown): boolean {
  return typeof value === "string" && value in LEGACY_VALUES;
}

/** Stored value (old or new, any case/whitespace) → product line. Unknown → standard. */
export function normalizeProductLine(value: unknown): ProductLine {
  if (typeof value !== "string") return DEFAULT_PRODUCT_LINE;
  const v = value.trim().toLowerCase();
  if ((PRODUCT_LINES as readonly string[]).includes(v)) return v as ProductLine;
  return LEGACY_VALUES[v] ?? DEFAULT_PRODUCT_LINE;
}

/**
 * The product line of an org row. platform_brand is authoritative; a row with a done-for-you
 * tier but no/standard platform_brand (a partial select, or a row read before provisioning
 * finished) is still done for you. Accepts the old `crankleads_tier` and the Phase 3 `plan_tier`.
 */
export function productLineForOrg(
  org: { platform_brand?: string | null; crankleads_tier?: string | null; plan_tier?: string | null } | null | undefined,
): ProductLine {
  if (!org) return DEFAULT_PRODUCT_LINE;
  const line = normalizeProductLine(org.platform_brand);
  if (line === "done_for_you") return line;
  if (org.plan_tier || org.crankleads_tier) return "done_for_you";
  return line;
}

export function isDoneForYou(value: unknown): boolean {
  return normalizeProductLine(value) === "done_for_you";
}

export function isDoneForYouOrg(org: Parameters<typeof productLineForOrg>[0]): boolean {
  return productLineForOrg(org) === "done_for_you";
}
