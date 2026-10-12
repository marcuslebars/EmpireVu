/**
 * Local row types for the Profit advisor's tables (migration 20261014120000_staff_profit_advisor.sql)
 * until they're merged into database.types.ts. `Db` is the untyped client cast used by the other
 * roles (sms-agent pattern) so these tables can be queried before the generated types know them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export type PriceChangeStatus = "proposed" | "applying" | "applied" | "declined" | "expired" | "stale" | "failed";

/** The numbers the owner saw when the change was proposed (so the next check can show the effect). */
export interface PriceChangeBasis {
  jobs: number;
  marginPct: number;
  companyMarginPct: number;
  quotes: number;
  winRatePct: number | null;
  windowDays: number;
}

export interface PriceChangeRow {
  id: string;
  organization_id: string;
  company_id: string;
  service_catalog_item_id: string | null;
  item_label: string;
  pricing_type: string;
  unit_label: string | null;
  status: PriceChangeStatus;
  old_rate_cents: number;
  new_rate_cents: number;
  old_minimum_cents: number;
  new_minimum_cents: number;
  pct: number;
  basis: PriceChangeBasis;
  run_key: string | null;
  approval_id: string | null;
  decided_at: string | null;
  applied_at: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export type RunKind = "weekly" | "pricing";
export type RunStatus = "claimed" | "sent" | "skipped" | "failed";

export interface ProfitRunRow {
  id: string;
  organization_id: string;
  company_id: string;
  kind: RunKind;
  run_key: string;
  status: RunStatus;
  attempts: number;
  body: string | null;
  detail: Record<string, unknown> | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
