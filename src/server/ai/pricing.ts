/**
 * AI token pricing for usage cost estimates (Task 6).
 *
 * Per-million-token prices in USD, env-overridable so the rates can track a model or
 * negotiated-pricing change without a deploy. Documented defaults are Anthropic's list
 * price for the default model, Claude Opus 5 (same rates as the Opus 4.8 it replaced):
 *   input        $5.00 / MTok   (AI_PRICE_INPUT_PER_MTOK)
 *   output       $25.00 / MTok  (AI_PRICE_OUTPUT_PER_MTOK)
 *   cache read   $0.50 / MTok   (~0.1× input)  (AI_PRICE_CACHE_READ_PER_MTOK)
 *   cache write  $6.25 / MTok   (~1.25× input) (AI_PRICE_CACHE_WRITE_PER_MTOK)
 * Those are the rates for every model unless a model FAMILY has its own: the AI front desk
 * (AI_MODEL_SMS_AGENT / AI_MODEL_OWNER_AGENT) defaults to claude-sonnet-5-5, so set
 *   AI_PRICE_SONNET_INPUT_PER_MTOK / _OUTPUT_ / _CACHE_READ_ / _CACHE_WRITE_PER_MTOK
 * to Sonnet's list price (likewise AI_PRICE_HAIKU_* / AI_PRICE_OPUS_*). An unset family rate
 * falls back to the AI_PRICE_* above. If you point AI_MODEL_* (ai/config.ts) at another model,
 * set its family's rates. Estimates only — the source of truth for spend is the provider invoice.
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

/** "claude-sonnet-5-5" → "SONNET" (the env prefix for that family's rates), else null. */
export function modelFamily(model: string | null | undefined): "OPUS" | "SONNET" | "HAIKU" | null {
  const m = (model ?? "").toLowerCase();
  if (m.includes("sonnet")) return "SONNET";
  if (m.includes("haiku")) return "HAIKU";
  if (m.includes("opus")) return "OPUS";
  return null;
}

/** Per-MTok rates for `model` (its family's AI_PRICE_<FAMILY>_* when set, else the defaults). */
export function aiRatesPerMTok(model?: string | null): AiRates {
  const base: AiRates = {
    input: rate("AI_PRICE_INPUT_PER_MTOK", 5.0),
    output: rate("AI_PRICE_OUTPUT_PER_MTOK", 25.0),
    cacheRead: rate("AI_PRICE_CACHE_READ_PER_MTOK", 0.5),
    cacheWrite: rate("AI_PRICE_CACHE_WRITE_PER_MTOK", 6.25),
  };
  const family = modelFamily(model);
  if (!family) return base;
  return {
    input: rate(`AI_PRICE_${family}_INPUT_PER_MTOK`, base.input),
    output: rate(`AI_PRICE_${family}_OUTPUT_PER_MTOK`, base.output),
    cacheRead: rate(`AI_PRICE_${family}_CACHE_READ_PER_MTOK`, base.cacheRead),
    cacheWrite: rate(`AI_PRICE_${family}_CACHE_WRITE_PER_MTOK`, base.cacheWrite),
  };
}

/** Cost in whole cents for `tokens` at a per-million-token dollar rate. */
export function tokenCostCents(tokens: number, perMTokDollars: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.round((tokens / 1_000_000) * perMTokDollars * 100);
}
