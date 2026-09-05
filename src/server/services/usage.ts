import { aiRatesPerMTok, tokenCostCents, type AiTokenUsage } from "@/server/ai/pricing";
import type { Inserts } from "@/server/db/database.types";
import { toJson } from "@/server/db/json";
// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION #2 (service role) — usage metering ledger (Task 6).
//
// usage_events has RLS with a members-SELECT policy but NO insert policy, so every
// metered WRITE goes through the service-role admin client. This module is the single
// place that writes the ledger. Callers that already hold an admin client use
// recordUsage(admin, …); callers on a request/RLS client use the best-effort
// self-creating wrappers recordUsageSafe / recordAiUsageSafe (metering must never fail
// a customer-facing send or an AI call). READS (getMonthlyUsage / getUsageForFeature)
// go through the caller's own RLS client — no service role needed. Listed in
// docs/EMPIREVU_RUNBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { createSupabaseServerClient } from "@/server/supabase/server";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type ReadClient = ReturnType<typeof createSupabaseServerClient> | AdminClient;

export type UsageKind =
  | "voice_minutes"
  | "sms_sent"
  | "sms_received"
  | "email_sent"
  | "ai_input_tokens"
  | "ai_output_tokens"
  | "ai_cache_read_tokens";

/** Feature → the usage kind whose monthly total it is limited by (used by orgLimit). */
export const FEATURE_USAGE_KIND: Record<string, UsageKind> = {
  marina_reception: "voice_minutes",
  sms_sequences: "sms_sent",
};

export interface RecordUsageInput {
  organizationId: string;
  companyId?: string | null;
  kind: UsageKind;
  quantity: number;
  unit: string;
  costCents?: number | null;
  provider?: string | null;
  /** The provider's own id for this event — the idempotency key. */
  providerRef?: string | null;
  occurredAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Record one metered event. Idempotent on (provider, provider_ref, kind): a duplicate
 * webhook delivery or retry records the event only once. Throws on a real DB error —
 * the best-effort wrappers below swallow that; direct callers decide.
 */
export async function recordUsage(admin: AdminClient, input: RecordUsageInput): Promise<void> {
  const row: Inserts<"usage_events"> = {
    organization_id: input.organizationId,
    company_id: input.companyId ?? null,
    kind: input.kind,
    quantity: input.quantity,
    unit: input.unit,
    cost_cents: input.costCents ?? null,
    provider: input.provider ?? null,
    provider_ref: input.providerRef ?? null,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    metadata: input.metadata ? toJson(input.metadata) : null,
  };
  const { error } = await admin
    .from("usage_events")
    .upsert(row, { onConflict: "provider,provider_ref,kind", ignoreDuplicates: true });
  if (error) {
    throw error;
  }
}

/** Best-effort recordUsage: self-creates the service-role client and never throws. */
export async function recordUsageSafe(input: RecordUsageInput): Promise<void> {
  try {
    await recordUsage(createSupabaseAdminClient(), input);
  } catch (err) {
    console.error(`[usage] failed to record ${input.kind}:`, err instanceof Error ? err.message : err);
  }
}

export interface AiUsageInput {
  organizationId: string;
  companyId?: string | null;
  provider?: string;
  model: string;
  /** response.id — the idempotency key shared by the three token events. */
  responseId: string;
  usage: AiTokenUsage;
}

/**
 * Record the three AI token kinds from one model response. All three share the response
 * id as provider_ref (distinct kind keeps them separate). Cache-creation tokens have no
 * kind of their own, so their cost is folded into the input event (quantity stays the
 * uncached input count). Zero-quantity kinds are skipped to keep the ledger clean.
 */
export async function recordAiUsage(admin: AdminClient, input: AiUsageInput): Promise<void> {
  const rates = aiRatesPerMTok();
  const provider = input.provider ?? "anthropic";
  const metadata = { model: input.model };

  const inputCost =
    tokenCostCents(input.usage.inputTokens, rates.input) +
    tokenCostCents(input.usage.cacheWriteTokens, rates.cacheWrite);

  const events: Array<{ kind: UsageKind; quantity: number; costCents: number }> = [
    { kind: "ai_input_tokens", quantity: input.usage.inputTokens, costCents: inputCost },
    {
      kind: "ai_output_tokens",
      quantity: input.usage.outputTokens,
      costCents: tokenCostCents(input.usage.outputTokens, rates.output),
    },
    {
      kind: "ai_cache_read_tokens",
      quantity: input.usage.cacheReadTokens,
      costCents: tokenCostCents(input.usage.cacheReadTokens, rates.cacheRead),
    },
  ];

  for (const event of events) {
    if (event.quantity <= 0) continue;
    await recordUsage(admin, {
      organizationId: input.organizationId,
      companyId: input.companyId ?? null,
      kind: event.kind,
      quantity: event.quantity,
      unit: "tokens",
      costCents: event.costCents,
      provider,
      providerRef: input.responseId,
      metadata,
    });
  }
}

/** Best-effort recordAiUsage: self-creates the service-role client and never throws. */
export async function recordAiUsageSafe(input: AiUsageInput): Promise<void> {
  try {
    await recordAiUsage(createSupabaseAdminClient(), input);
  } catch (err) {
    console.error("[usage] failed to record AI usage:", err instanceof Error ? err.message : err);
  }
}

export interface MonthlyUsageRow {
  kind: string;
  quantity: number;
  costCents: number;
  companyId: string | null;
}

/** First day of a month in America/Toronto, as 'YYYY-MM-01' — matches usage_monthly_v. */
export function torontoMonthStart(month?: string | Date): string {
  if (typeof month === "string" && /^\d{4}-\d{2}/.test(month)) {
    return `${month.slice(0, 7)}-01`;
  }
  const when = month instanceof Date ? month : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(when);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const monthPart = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${monthPart}-01`;
}

/** Per-kind monthly rollup for an org (one row per company × kind). RLS-scoped read. */
export async function getMonthlyUsage(
  supabase: ReadClient,
  organizationId: string,
  month?: string | Date,
): Promise<MonthlyUsageRow[]> {
  const monthStart = torontoMonthStart(month);
  const { data, error } = await supabase
    .from("usage_monthly_v")
    .select("kind, quantity, cost_cents, company_id")
    .eq("organization_id", organizationId)
    .eq("month", monthStart);
  if (error) {
    throw error;
  }
  return (data ?? []).map((row) => ({
    kind: row.kind ?? "",
    quantity: Number(row.quantity ?? 0),
    costCents: Number(row.cost_cents ?? 0),
    companyId: row.company_id,
  }));
}

/** This month's total quantity for the usage kind a feature is limited by. */
export async function getUsageForFeature(
  supabase: ReadClient,
  organizationId: string,
  feature: string,
): Promise<number> {
  const kind = FEATURE_USAGE_KIND[feature];
  if (!kind) {
    return 0;
  }
  const rows = await getMonthlyUsage(supabase, organizationId);
  return rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.quantity, 0);
}
