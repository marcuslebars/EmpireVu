/**
 * QuickBooks Online / Xero app credentials + endpoints. SERVER-ONLY. A provider is
 * offered in Settings only when its client id + secret are set and ACCOUNTING_TOKEN_KEY
 * (which encrypts the stored tokens) is valid. Endpoint overrides exist for local testing.
 */
export type ProviderId = "quickbooks" | "xero";

export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  environment: "sandbox" | "production";
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
  minorVersion: string;
  scopes: string;
}

export interface XeroConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  connectionsUrl: string;
  apiBase: string;
  scopes: string;
}

const env = (name: string) => process.env[name]?.trim() || "";

export function quickBooksConfig(): QuickBooksConfig {
  const environment = env("QUICKBOOKS_ENVIRONMENT") === "sandbox" ? "sandbox" : "production";
  return {
    clientId: env("QUICKBOOKS_CLIENT_ID"),
    clientSecret: env("QUICKBOOKS_CLIENT_SECRET"),
    environment,
    authorizeUrl: env("QUICKBOOKS_AUTHORIZE_URL") || "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: env("QUICKBOOKS_TOKEN_URL") || "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revokeUrl: env("QUICKBOOKS_REVOKE_URL") || "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    apiBase:
      env("QUICKBOOKS_API_BASE") ||
      (environment === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com"),
    // Intuit retired minor versions 1–74 (Aug 2025); 75 is the floor.
    minorVersion: env("QUICKBOOKS_MINOR_VERSION") || "75",
    scopes: "com.intuit.quickbooks.accounting",
  };
}

/**
 * Xero apps created on/after 2 March 2026 only get the granular scopes; older apps can
 * use them too (the broad ones go away in Sept 2027). XERO_SCOPES overrides.
 */
export const XERO_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices",
  "accounting.payments",
  "accounting.banktransactions",
  "accounting.contacts",
  "accounting.settings.read",
  "accounting.attachments",
].join(" ");

export function xeroConfig(): XeroConfig {
  return {
    clientId: env("XERO_CLIENT_ID"),
    clientSecret: env("XERO_CLIENT_SECRET"),
    authorizeUrl: env("XERO_AUTHORIZE_URL") || "https://login.xero.com/identity/connect/authorize",
    tokenUrl: env("XERO_TOKEN_URL") || "https://identity.xero.com/connect/token",
    revokeUrl: env("XERO_REVOKE_URL") || "https://identity.xero.com/connect/revocation",
    connectionsUrl: env("XERO_CONNECTIONS_URL") || "https://api.xero.com/connections",
    apiBase: env("XERO_API_BASE") || "https://api.xero.com/api.xro/2.0",
    scopes: env("XERO_SCOPES") || XERO_DEFAULT_SCOPES,
  };
}

/** Where the provider sends people back: {APP_BASE_URL}/api/accounting/callback/{provider}. */
export function redirectUri(provider: ProviderId): string {
  const base = (env("ACCOUNTING_REDIRECT_BASE_URL") || env("APP_BASE_URL") || "https://app.empirevu.com").replace(/\/+$/, "");
  return `${base}/api/accounting/callback/${provider}`;
}

export function tokenKeyConfigured(): boolean {
  const raw = env("ACCOUNTING_TOKEN_KEY");
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
}

export function providerConfigured(provider: ProviderId): boolean {
  if (!tokenKeyConfigured()) return false;
  const c = provider === "quickbooks" ? quickBooksConfig() : xeroConfig();
  return Boolean(c.clientId && c.clientSecret);
}

export const PROVIDER_LABELS: Record<ProviderId, string> = { quickbooks: "QuickBooks Online", xero: "Xero" };
