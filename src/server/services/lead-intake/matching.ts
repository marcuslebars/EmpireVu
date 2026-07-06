/** Customer-matching normalization. Pure functions — no I/O. */

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Digits-only, last-10 comparison so +1 / formatting variance still matches.
 * Returns null when there aren't at least 10 digits (too weak to match on).
 */
export function normalizePhoneLast10(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** Do two contacts' normalized keys match on email OR phone-last-10? */
export function keysMatch(
  a: { email?: string | null; phone?: string | null },
  b: { email?: string | null; phone?: string | null },
): boolean {
  const aEmail = normalizeEmail(a.email);
  const bEmail = normalizeEmail(b.email);
  if (aEmail && bEmail && aEmail === bEmail) return true;
  const aPhone = normalizePhoneLast10(a.phone);
  const bPhone = normalizePhoneLast10(b.phone);
  return Boolean(aPhone && bPhone && aPhone === bPhone);
}
