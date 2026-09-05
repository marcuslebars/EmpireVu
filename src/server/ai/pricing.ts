/**
 * AI token pricing for usage cost estimates (Task 6).
 *
 * Per-million-token prices in USD, env-overridable so the rates can track a model or
 * negotiated-pricing change without a deploy. Documented defaults are Anthropic's list
 * price for the default model, Claude Opus 4.8:
 *   input        $5.00 / MTok   (AI_PRICE_INPUT_PER_MTOK)
 *   output       $25.00 / MTok  (AI_PRICE_OUTPUT_PER_MTOK)
 *   cache read   $0.50 / MTok   (~0.1× input)  (AI_PRICE_CACHE_READ_PER_MTOK)
 *   cache write  $6.25 / MTok   (~1.25× input) (AI_PRICE_CACHE_WRITE_PER_MTOK)
 * If you point AI_MODEL_* (ai/config.ts) at a cheaper model, set these to that model's
 * rates as well. Estimates only — the source of truth for spend is the provider invoice.
 */

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AiRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function rate(envVar: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[envVar] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function aiRatesPerMTok(): AiRates {
  return {
    input: rate("AI_PRICE_INPUT_PER_MTOK", 5.0),
    output: rate("AI_PRICE_OUTPUT_PER_MTOK", 25.0),
    cacheRead: rate("AI_PRICE_CACHE_READ_PER_MTOK", 0.5),
    cacheWrite: rate("AI_PRICE_CACHE_WRITE_PER_MTOK", 6.25),
  };
}

/** Cost in whole cents for `tokens` at a per-million-token dollar rate. */
export function tokenCostCents(tokens: number, perMTokDollars: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.round((tokens / 1_000_000) * perMTokDollars * 100);
}
