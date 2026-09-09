import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { getWorkflowsModel } from "@/server/ai/config";
import { extractAiUsage, isAIConfigured, type AiUsageMeta } from "@/server/ai/claude";
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

const MAX_BYTES = 60_000;
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

function stripJsonFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/** Parse Claude's JSON into validated drafts. Throws on invalid JSON; drops bad rows. Pure. */
export function parseCatalogResponse(raw: string): CatalogDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    throw new Error("The AI response was not valid JSON.");
  }
  return responseSchema.parse(parsed).services;
}

/** SSRF guard: only public http(s) hosts. */
function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid website URL (including https://).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported.");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error("That host isn't reachable.");
  return url;
}

/** Fetch a page server-side and return its readable text (10s timeout, capped). */
export async function fetchWebsiteText(rawUrl: string): Promise<string> {
  const url = assertFetchableUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "EmpireVu-Onboarding/1.0", Accept: "text/html" },
    });
    if (!response.ok) throw new Error(`Couldn't fetch the site (${response.status}).`);
    const html = (await response.text()).slice(0, MAX_BYTES * 4);
    return extractReadableText(html);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("The site took too long to respond.");
    throw err instanceof Error ? err : new Error("Couldn't fetch the site.");
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `You extract a services catalog from a small business's website text. Return ONLY the services this business sells, as a strict JSON object — no markdown, no prose.

Rules:
- Each service: a short "name", an optional one-sentence "description", a "pricingType", and "baseCents".
- "pricingType" is one of: "flat" (a fixed price), "per_unit" (priced per item/engine), "per_measure" (priced per foot/km/unit of size), "per_unit_declining", "tiered_by_measure", "per_measure_banded". Default to "flat" if unsure.
- "baseCents": the price in CENTS, ONLY if the site clearly states a number for that service (e.g. "$150" -> 15000). If no clear price is stated, use null. NEVER invent a price.
- Only include real, sellable services. Ignore navigation, blog posts, and boilerplate. Max 40.

Respond with exactly:
{"services":[{"name":string,"description":string|null,"pricingType":string,"baseCents":number|null}]}`;

export async function draftCatalogFromWebsite(
  rawUrl: string,
): Promise<{ drafts: CatalogDraft[]; usage: AiUsageMeta; sourceChars: number }> {
  if (!isAIConfigured()) {
    throw new Error("AI is not configured. Set ANTHROPIC_API_KEY on the server to parse a website.");
  }
  const text = await fetchWebsiteText(rawUrl);
  if (text.length < 40) {
    throw new Error("That page didn't have enough readable text to work from.");
  }

  const client = new Anthropic();
  const model = getWorkflowsModel();
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Website text:\n\n${text}` }],
  });
  const usage = extractAiUsage(response, model);
  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  return { drafts: parseCatalogResponse(raw), usage, sourceChars: text.length };
}
