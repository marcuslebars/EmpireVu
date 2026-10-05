import Anthropic from "@anthropic-ai/sdk";

import { getReceiptsModel } from "@/server/ai/config";
import { extractAiUsage, isAIConfigured, parseModelJson, type AiUsageMeta } from "@/server/ai/claude";
import { EXPENSE_CATEGORIES, cleanReceiptScan, receiptScanSchema, type ReceiptScan, type ReceiptType } from "@/server/services/expenses/rules";

/**
 * Snap a receipt → the expense form fills itself. The model reads the image / PDF and
 * returns a strict JSON object; cleanReceiptScan then drops anything doubtful so the
 * person only ever sees a suggestion they confirm, never a silently saved guess.
 */

const SYSTEM_PROMPT = `You read one purchase receipt or supplier invoice for a small service business (trades, cleaning, landscaping, marine, etc.) and return what it says as a strict JSON object.

Rules:
- "vendor": the store or supplier name as printed (short, e.g. "Home Depot"), or null.
- "date": the purchase date as YYYY-MM-DD, or null if it isn't printed clearly. Never guess a year that isn't shown.
- "totalCents": the final amount paid, tax included, in CENTS (e.g. $45.20 -> 4520), or null.
- "taxCents": the sales tax on the receipt in CENTS (HST/GST/PST/QST/VAT/sales tax, all of them added together), 0 if the receipt clearly shows no tax, or null if unclear.
- "category": the best fit from this list, or null: ${EXPENSE_CATEGORIES.join(", ")}. Building supplies, parts and consumables are "materials"; gas stations are "fuel" unless it's clearly food; restaurants and coffee are "meals".
- "description": a few words on what was bought (e.g. "Shrink wrap and tape"), or null.
- If the image isn't a receipt, return every field as null.

The response shape is fixed by a schema — fill in every field.`;

const RECEIPT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["vendor", "date", "totalCents", "taxCents", "category", "description"],
  properties: {
    vendor: { type: ["string", "null"] },
    date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    totalCents: { type: ["integer", "null"] },
    taxCents: { type: ["integer", "null"] },
    category: { anyOf: [{ type: "string", enum: [...EXPENSE_CATEGORIES] }, { type: "null" }] },
    description: { type: ["string", "null"] },
  },
};

export class ReceiptReadingUnavailableError extends Error {
  constructor() {
    super("Reading receipts isn't set up on this server — fill the details in by hand.");
    this.name = "ReceiptReadingUnavailableError";
  }
}

export async function readReceipt(
  file: { bytes: Buffer; type: ReceiptType },
  today: string,
): Promise<{ scan: ReceiptScan; usage: AiUsageMeta }> {
  if (!isAIConfigured()) throw new ReceiptReadingUnavailableError();
  const data = file.bytes.toString("base64");
  const fileBlock: Anthropic.ContentBlockParam =
    file.type === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };

  const client = new Anthropic();
  const model = getReceiptsModel();
  const response = await client.messages.create({
    model,
    // Room for adaptive thinking (adding up several tax lines) plus the small JSON answer —
    // a cut-off answer is a parse failure.
    max_tokens: 8_000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [fileBlock, { type: "text", text: `Today is ${today}. Read this receipt.` }] }],
    output_config: { format: { type: "json_schema", schema: RECEIPT_JSON_SCHEMA } },
  });
  const usage = extractAiUsage(response, model);
  const raw = receiptScanSchema.parse(parseModelJson(response, "receipt"));
  return { scan: cleanReceiptScan(raw, today), usage };
}
