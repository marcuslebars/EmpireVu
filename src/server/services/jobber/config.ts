// Jobber integration config + row types. SERVER-ONLY — never import into client
// code. All secrets come from Railway env (no VITE_ prefix). The integration is
// inert unless JOBBER_SYNC_ENABLED === "1".
//
// The jobber_* tables are not yet in the generated database.types.ts (no gen-types
// step here), so we access them via the admin client cast to any and shape results
// with the row interfaces below. Regenerating database.types.ts after this migration
// (supabase gen types) restores first-class typing — tracked in docs/jobber-integration.md.

export interface JobberConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  graphqlVersion: string;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  graphqlUrl: string;
  deposit: JobberDepositConfig;
}

/** Required-deposit policy for auto-sent quotes. A flat override wins over percent. */
export interface JobberDepositConfig {
  percent: number; // e.g. 25 → deposit is 25% of the quote subtotal
  flatCents: number | null; // optional fixed override (ignores percent when set)
  minCents: number; // optional floor
}

export function getJobberConfig(): JobberConfig {
  return {
    enabled: process.env.JOBBER_SYNC_ENABLED === "1",
    clientId: process.env.JOBBER_CLIENT_ID ?? "",
    clientSecret: process.env.JOBBER_CLIENT_SECRET ?? "",
    redirectUri: process.env.JOBBER_REDIRECT_URI ?? "https://api.tilotto.com/api/jobber/callback",
    // Pin the active dated version; confirm the latest in the Developer Center.
    graphqlVersion: process.env.JOBBER_GRAPHQL_VERSION ?? "2025-04-16",
    scopes: process.env.JOBBER_SCOPES ?? "",
    authorizeUrl: process.env.JOBBER_AUTHORIZE_URL ?? "https://api.getjobber.com/api/oauth/authorize",
    tokenUrl: process.env.JOBBER_TOKEN_URL ?? "https://api.getjobber.com/api/oauth/token",
    graphqlUrl: process.env.JOBBER_GRAPHQL_URL ?? "https://api.getjobber.com/api/graphql",
    deposit: {
      percent: numEnv("JOBBER_DEPOSIT_PERCENT", 25),
      flatCents: intEnvOrNull("JOBBER_DEPOSIT_FLAT_CENTS"),
      minCents: numEnv("JOBBER_DEPOSIT_MIN_CENTS", 0),
    },
  };
}

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function intEnvOrNull(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Deposit (cents) required to reserve, derived from the quote subtotal. A flat override
 * wins; otherwise `percent` of subtotal, floored at `minCents`, and never above the
 * subtotal itself. Returns 0 for a non-positive subtotal.
 */
export function computeDepositCents(subtotalCents: number, deposit: JobberDepositConfig): number {
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return 0;
  const base = deposit.flatCents != null ? deposit.flatCents : Math.round((subtotalCents * deposit.percent) / 100);
  return Math.min(subtotalCents, Math.max(base, deposit.minCents, 0));
}

export function assertJobberConfigured(cfg: JobberConfig): void {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("Jobber is not configured (JOBBER_CLIENT_ID / JOBBER_CLIENT_SECRET missing).");
  }
}

export interface JobberSyncLineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface JobberSyncPayload {
  formType: string;
  source: string;
  sourceSite: string;
  contact: { name?: string; email?: string; phone?: string };
  message?: string;
  lineItems?: JobberSyncLineItem[];
  asset?: { makeModel?: string; lengthFt?: number; type?: string; marina?: string };
  locality?: string;
}

export type JobberSyncJobStatus = "pending" | "running" | "completed" | "failed" | "manual_review";

export interface JobberSyncJobRow {
  id: string;
  organization_id: string;
  company_id: string | null;
  lead_id: string;
  contact_id: string | null;
  payload: JobberSyncPayload;
  status: JobberSyncJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  last_attempted_at: string | null;
  locked_at: string | null;
  locked_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  jobber_client_id: string | null;
  jobber_quote_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobberConnectionRow {
  organization_id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  refresh_lock_at: string | null;
  scope: string | null;
  jobber_account_name: string | null;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}
