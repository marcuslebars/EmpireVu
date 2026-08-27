// Stripe-native quotes config. SERVER-ONLY — never import into client code. The whole
// feature is inert unless STRIPE_QUOTES_ENABLED === "1". No Stripe secrets live here yet;
// Phases 3-4 add the Checkout + invoice flow, reusing the existing billing infrastructure.

export interface QuotesConfig {
  enabled: boolean;
  /**
   * HST rate in basis points (1300 = 13%). Stripe Tax is authoritative at charge time
   * (Phase 3); this is the quote-time estimate used for display and for sizing the deposit.
   */
  taxRateBps: number;
  /** Deposit as a fraction of the tax-inclusive total, in basis points (2500 = 25%). */
  depositRateBps: number;
  /** Quote validity window (days) → expires_at. */
  expiryDays: number;
  /**
   * Origin for CUSTOMER-facing quote links (/q/{token}) and the Stripe Checkout
   * return URLs.
   *
   * Separate from APP_BASE_URL because the hub app and the public surface may sit
   * on different hosts (empirevu.com vs api.empirevu.com). Defaults to
   * APP_BASE_URL so a single-host deployment needs no extra config.
   *
   * This must match the host a customer actually reaches, because Stripe redirects
   * back to it after payment — a mismatch strands them on a dead URL holding a
   * charged card.
   */
  publicBaseUrl: string;
}

export function getQuotesConfig(): QuotesConfig {
  return {
    enabled: process.env.STRIPE_QUOTES_ENABLED === "1",
    taxRateBps: intEnv("QUOTE_TAX_RATE_BPS", 1300),
    depositRateBps: intEnv("QUOTE_DEPOSIT_BPS", 2500),
    expiryDays: intEnv("QUOTE_EXPIRY_DAYS", 30),
    publicBaseUrl: (
      process.env.QUOTE_PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, ""),
  };
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}
