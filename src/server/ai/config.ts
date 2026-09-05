/**
 * AI model selection (Task 6).
 *
 * Each AI surface reads its model from an env var so the owner can move a surface to a
 * smaller/cheaper model without a code change. Defaults are the CURRENT production
 * values (`claude-opus-4-8`) — changing the env changes the model on the next request.
 * If you switch a surface to a cheaper model, update the matching AI_PRICE_* rates in
 * ai/pricing.ts too, so the cost estimates stay honest.
 */

const DEFAULT_MODEL = "claude-opus-4-8";

export function getDraftsModel(): string {
  return process.env.AI_MODEL_DRAFTS?.trim() || DEFAULT_MODEL;
}

export function getWorkflowsModel(): string {
  return process.env.AI_MODEL_WORKFLOWS?.trim() || DEFAULT_MODEL;
}
