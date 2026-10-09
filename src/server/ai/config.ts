/**
 * AI model selection (Task 6).
 *
 * Each AI surface reads its model from an env var so the owner can move a surface to a
 * smaller/cheaper model without a code change. Defaults are the CURRENT production
 * values (`claude-opus-5`) — changing the env changes the model on the next request.
 * If you switch a surface to a cheaper model, update the matching AI_PRICE_* rates in
 * ai/pricing.ts too, so the cost estimates stay honest.
 *
 * Opus 5 costs the same per token as the Opus 4.8 it replaced ($5/$25 per MTok), and
 * thinks by default — the surfaces that ask for JSON set `thinking: adaptive` anyway.
 */

const DEFAULT_MODEL = "claude-opus-5";
/** The AI front desk (customer texts, owner commands): fast and cheaper. Price it with AI_PRICE_SONNET_*. */
export const FRONT_DESK_DEFAULT_MODEL = "claude-sonnet-5-5";

export function getDraftsModel(): string {
  return process.env.AI_MODEL_DRAFTS?.trim() || DEFAULT_MODEL;
}

export function getWorkflowsModel(): string {
  return process.env.AI_MODEL_WORKFLOWS?.trim() || DEFAULT_MODEL;
}

/**
 * The in-app Help assistant (docs/help-assistant.md). Short, grounded answers over the help
 * articles — a smaller model is a good fit; if you move it, set AI_PRICE_* to match.
 */
export function getHelpModel(): string {
  return process.env.AI_MODEL_HELP?.trim() || DEFAULT_MODEL;
}

/**
 * Reading a receipt photo / PDF into an expense (docs/expenses.md). A short, structured
 * extraction — a smaller model works; if you move it, set AI_PRICE_* to match.
 */
export function getReceiptsModel(): string {
  return process.env.AI_MODEL_RECEIPTS?.trim() || DEFAULT_MODEL;
}

/**
 * The AI front desk's text conversations with customers (sms-agent/, docs/front-desk-ai.md).
 * A fast, cheaper model by default — replies must land within seconds. If you change it, set
 * AI_PRICE_* to match so the usage ledger stays honest.
 */
export function getSmsAgentModel(): string {
  return process.env.AI_MODEL_SMS_AGENT?.trim() || FRONT_DESK_DEFAULT_MODEL;
}

/**
 * The owner's text commands ("what's on tomorrow", "move Jones to Friday") — owner-channel/
 * agent.ts, docs/front-desk-ai.md "Owner by text". Same fast default as the SMS agent.
 */
export function getOwnerAgentModel(): string {
  return process.env.AI_MODEL_OWNER_AGENT?.trim() || FRONT_DESK_DEFAULT_MODEL;
}
