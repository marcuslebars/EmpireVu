/**
 * Canadian NANP area codes (CRTC / CNA list, incl. overlays in service through 2026). Used to
 * buy AI receptionist numbers in the right country: Retell's create-phone-number takes
 * country_code "US" | "CA", and a Canadian area code asked for under "US" can never be found.
 */
export const CANADIAN_AREA_CODES: ReadonlySet<number> = new Set([
  204, 226, 236, 249, 250, 257, 263, 289, 306, 343, 354, 365, 367, 368, 382, 387, 403, 416, 418, 428, 431, 437, 438,
  450, 460, 468, 474, 506, 514, 519, 537, 548, 568, 579, 581, 584, 587, 604, 613, 639, 647, 672, 683, 705, 709, 742,
  753, 778, 780, 782, 807, 819, 825, 851, 867, 873, 879, 902, 905, 942,
]);

export function isCanadianAreaCode(areaCode: number | null | undefined): boolean {
  return typeof areaCode === "number" && CANADIAN_AREA_CODES.has(areaCode);
}

/** The area code of a +1 number, or null. */
export function areaCodeOf(phone: string | null | undefined): number | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? Number(ten.slice(0, 3)) : null;
}

/** "CA" when the requested area code (else the owner's / business line's) is Canadian; else "US". */
export function retellCountryFor(areaCode: number | null | undefined, ...fallbackPhones: Array<string | null | undefined>): "US" | "CA" {
  if (areaCode) return isCanadianAreaCode(areaCode) ? "CA" : "US";
  for (const phone of fallbackPhones) {
    const code = areaCodeOf(phone);
    if (code) return isCanadianAreaCode(code) ? "CA" : "US";
  }
  return "US";
}
