import Anthropic from "@anthropic-ai/sdk";

import { extractAiUsage, isAIConfigured, parseModelJson, type AiUsageMeta } from "@/server/ai/claude";
import { getDraftsModel } from "@/server/ai/config";
import {
  SITE_COPY_JSON_SCHEMA,
  siteCopyModelSchema,
  type SiteCopyModelOutput,
} from "@/server/services/dfy/site-content";

/**
 * Website copy for a generated site (docs/done-for-you.md → "Generated sites"). The model gets a
 * facts JSON (no prices) and rephrases it — it is told to add nothing. Its answer is validated
 * with zod here and screened against the facts by the caller (screenSiteCopy); any failure
 * falls back to template copy, so a model outage never blocks a site.
 */

const SYSTEM_PROMPT = `You write the words for a small trades business's one-page website (snow removal, landscaping, roofing, HVAC, marine, contracting) in Ontario, Canada.

You are given a FACTS JSON. Use ONLY those facts. Rephrase them in a plain, friendly contractor voice — short sentences, no hype, no buzzwords, no exclamation marks. Canadian spelling (colour, neighbour, centre, favourite, labour).

Never add anything that is not in the facts. In particular, do NOT mention or imply:
- years in business, founding dates, "family-owned", "decades of experience";
- licences, insurance, bonding, certifications, warranties, guarantees, awards, ratings or stars;
- prices, discounts, "free estimates", "same-day", "24/7" or emergency service;
- review quotes or what customers say.
If a fact you would like to use is missing, leave it out.

Fields:
- headline: what they do and where, at most 70 characters. Plain words, no question.
- subhead: one or two short sentences telling the visitor how to get a price (call the phone number if given, or send a quote request on this page; mention online booking only if onlineBooking is true). At most 200 characters.
- about: 2 to 4 sentences about the business, built only from businessName, trade, serviceArea, services, tagline, ownerAbout and highlights. At most 600 characters.
- serviceBlurbs: for each service (use its exact "key"), one plain line (at most 120 characters) on what the service is. No prices.
- faqs: 3 to 5 questions a homeowner would ask, each answered strictly from the facts (how to get a quote, service area, hours, online booking, what services are offered). Answers at most 2 short sentences.
If mode is "price_page", the business already has its own website; the page is their services, prices and booking page, so keep the headline about services and prices.

The response shape is fixed by a schema — fill in every field it asks for.`;

export interface SiteCopyResult {
  copy: SiteCopyModelOutput;
  usage: AiUsageMeta;
}

/** Ask Claude for site copy. Throws when AI isn't configured or the answer fails validation. */
export async function writeSiteCopy(facts: Record<string, unknown>): Promise<SiteCopyResult> {
  if (!isAIConfigured()) throw new Error("AI is not configured.");
  const client = new Anthropic();
  const model = getDraftsModel();
  const response = await client.messages.create({
    model,
    max_tokens: 4_000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `FACTS JSON:\n${JSON.stringify(facts, null, 2)}` }],
    output_config: { format: { type: "json_schema", schema: SITE_COPY_JSON_SCHEMA } },
  });
  const copy = siteCopyModelSchema.parse(parseModelJson(response, "website copy"));
  return { copy, usage: extractAiUsage(response, model) };
}
