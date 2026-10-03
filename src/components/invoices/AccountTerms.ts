/**
 * Payment-terms helpers for business accounts.
 * payment_terms_days: null = use the company default, 0 = due on receipt, N = Net N.
 */

export const ACCOUNT_TERM_PRESETS = [0, 7, 15, 30, 45, 60] as const;

/** Select value for the terms picker: "default", a preset ("0", "30"…), or "custom". */
export type AccountTermsChoice = "default" | "custom" | `${number}`;

export function accountTermsLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return "Company default";
  if (days === 0) return "Due on receipt";
  return `Net ${days}`;
}

export function termsToChoice(days: number | null | undefined): AccountTermsChoice {
  if (days === null || days === undefined) return "default";
  return (ACCOUNT_TERM_PRESETS as readonly number[]).includes(days) ? `${days}` : "custom";
}

/**
 * Resolve the picker back to payment_terms_days. Returns `undefined` when the
 * custom value is not a whole number between 0 and 365.
 */
export function choiceToTerms(choice: AccountTermsChoice, customDays: string): number | null | undefined {
  if (choice === "default") return null;
  if (choice === "custom") {
    const n = Number(customDays.trim());
    return customDays.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 365 ? n : undefined;
  }
  return Number(choice);
}
