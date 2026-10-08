import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { getWorkflowsModel } from "@/server/ai/config";
import { extractAiUsage, extractJsonObject, isAIConfigured, parseModelJson, type AiUsageMeta } from "@/server/ai/claude";
import { isPageContentType, safeFetchText, type SafeFetchOptions } from "@/server/net/safe-fetch";
import { ValidationError } from "@/server/organizations/context";
import { PRICING_TYPES } from "@/server/services/quotes/catalog-items";

/**
 * "Paste your website URL" → draft service_catalog_items (Task 13). The server fetches the
 * page, strips it to readable text, and asks Claude for a strict JSON array of service
 * drafts. Drafts are proposals only — the user edits/confirms before anything is inserted,
 * and a base price is left blank unless the site clearly states one.
 *
 * extractReadableText + parseCatalogResponse are pure and golden-tested; fetchWebsiteText
 * and draftCatalogFromWebsite do the I/O.
 */

export const MAX_BYTES = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Strip scripts/styles/tags to readable text and cap the size. Pure. */
export function extractReadableText(html: string, maxBytes: number = MAX_BYTES): string {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

const catalogDraftSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  pricingType: z.enum(PRICING_TYPES).default("flat"),
  baseCents: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
});

export type CatalogDraft = z.infer<typeof catalogDraftSchema>;

const responseSchema = z.object({ services: z.array(catalogDraftSchema).max(40).default([]) });

/** Parse Claude's JSON into validated drafts. Throws on invalid JSON; drops bad rows. Pure. */
export function parseCatalogResponse(raw: string): CatalogDraft[] {
  return responseSchema.parse(extractJsonObject(raw)).services;
}

/** Fetch a page server-side (SSRF-guarded, 10s timeout, capped) and return its readable text. */
export async function fetchWebsiteText(rawUrl: string, options: SafeFetchOptions = {}): Promise<string> {
  const page = await safeFetchText(rawUrl, { maxBytes: MAX_BYTES * 4, timeoutMs: FETCH_TIMEOUT_MS, ...options });
  if (page.status < 200 || page.status >= 300) throw new ValidationError(`Couldn't fetch the site (${page.status}).`);
  if (!isPageContentType(page.contentType)) throw new ValidationError("That link isn't a web page.");
  return extractReadableText(page.body);
}

/**
 * Several pages of one site (homepage, services, pricing…) as one text block for the parser,
 * each headed by its URL so the model can tell them apart. Pure; capped like a single page.
 */
export function combinePageTexts(pages: Array<{ url: string; text: string }>, maxBytes: number = MAX_BYTES): string {
  const parts: string[] = [];
  let used = 0;
  for (const page of pages) {
    const text = page.text.trim();
    if (!text) continue;
    const block = `--- Page: ${page.url} ---\n${text}`;
    const room = maxBytes - used;
    if (room <= 200) break;
    parts.push(block.length > room ? block.slice(0, room) : block);
    used += Math.min(block.length, room) + 2;
  }
  return parts.join("\n\n");
}

const SYSTEM_PROMPT = `You extract a services catalog from a small business's website text. Return ONLY the services this business sells, as a strict JSON object — no markdown, no prose.

Rules:
- Each service: a short "name", an optional one-sentence "description", a "pricingType", and "baseCents".
- "pricingType" is one of: "flat" (a fixed price), "per_unit" (priced per item/engine), "per_measure" (priced per foot/km/unit of size), "per_unit_declining", "tiered_by_measure", "per_measure_banded". Default to "flat" if unsure.
- "baseCents": the price in CENTS, ONLY if the site clearly states a number for that service (e.g. "$150" -> 15000). If no clear price is stated, use null. NEVER invent a price.
- Only include real, sellable services. Ignore navigation, blog posts, and boilerplate. Max 40.

The response shape is fixed by a schema — fill in every field it asks for.`;

/** Enforced by the API, so the answer can't arrive wrapped in prose or code fences. */
const CATALOG_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["services"],
  properties: {
    services: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "pricingType", "baseCents"],
        properties: {
          name: { type: "string", description: "Short service name." },
          description: { type: ["string", "null"], description: "One sentence, or null." },
          pricingType: { type: "string", enum: [...PRICING_TYPES] },
          baseCents: {
            type: ["integer", "null"],
            minimum: 0,
            description: "Price in cents, only when the site states one. Never invented.",
          },
        },
      },
    },
  },
};

export async function draftCatalogFromWebsite(
  rawUrl: string,
): Promise<{ drafts: CatalogDraft[]; usage: AiUsageMeta; sourceChars: number }> {
  if (!isAIConfigured()) {
    throw new Error("AI is not configured. Set ANTHROPIC_API_KEY on the server to parse a website.");
  }
  const text = await fetchWebsiteText(rawUrl);
  return draftCatalogFromText(text);
}

/**
 * Draft services from text already fetched — one page, or several pages of the same site
 * joined with combinePageTexts (the done-for-you crawl). Prices only when the text states them.
 */
export async function draftCatalogFromText(
  text: string,
): Promise<{ drafts: CatalogDraft[]; usage: AiUsageMeta; sourceChars: number }> {
  if (!isAIConfigured()) {
    throw new Error("AI is not configured. Set ANTHROPIC_API_KEY on the server to parse a website.");
  }
  if (text.length < 40) {
    throw new ValidationError("That page didn't have enough readable text to work from.");
  }

  const client = new Anthropic();
  const model = getWorkflowsModel();
  const response = await client.messages.create({
    model,
    // Up to 40 services with descriptions doesn't fit in 4k — a cut-off answer is a parse failure.
    max_tokens: 16_000,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Website text:\n\n${text}` }],
    output_config: { format: { type: "json_schema", schema: CATALOG_JSON_SCHEMA } },
  });
  const usage = extractAiUsage(response, model);
  const drafts = responseSchema.parse(parseModelJson(response, "services catalog")).services;

  return { drafts, usage, sourceChars: text.length };
}
