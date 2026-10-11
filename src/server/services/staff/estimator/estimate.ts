/**
 * Turning the model's draft into a priced estimate (PURE-ish: pricing goes through the injected
 * priceQuote, i.e. priceQuoteForCompany — the same math the quote will use), the owner's
 * approval text, and the owner's "Y 12 $900" re-price.
 */
import type { QuotePricing } from "@/server/services/quotes/pricing";
import type { BusinessFacts } from "@/server/services/sms-agent/facts";
import type { EstimateCustomLine, EstimateJson, EstimateLine, EstimateService } from "@/server/services/staff/estimator/db-types";
import type { EstimatorDeps } from "@/server/services/staff/estimator/deps";
import { clip, dollars, prettyPhone } from "@/server/services/staff/estimator/text";
import { MAX_CUSTOM_LINE_CENTS, type EstimateDraft } from "@/server/services/staff/estimator/vision";

export const MIN_CUSTOM_LINE_CENTS = 100;
/** owner_approvals.summary is capped at 500; the notify step adds the code + reply line. */
export const MAX_ESTIMATE_SUMMARY = 480;

/** A quote-line label from model text: plain words only, no links, no amounts. PURE. */
export function cleanLineLabel(raw: string | null | undefined, businessName: string): string | null {
  if (!raw) return null;
  const t = raw
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, " ")
    .replace(/\b(crankleads|empirevu)\b/gi, businessName)
    .replace(/[<>{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return t.length >= 2 ? t : null;
}

export type PricedEstimate =
  | { ok: true; estimate: EstimateJson }
  | { ok: false; reason: "too_vague"; questions: string[] }
  | { ok: false; reason: "unpriceable"; questions: string[] };

const FALLBACK_QUESTIONS = ["What exactly needs doing, and roughly how big is the job?", "Could you text a photo or two of it?"];

function toService(line: { serviceKey: string; quantity: number | null; measure: number | null; choices: Record<string, string> | null }): EstimateService {
  return {
    serviceId: line.serviceKey,
    ...(line.quantity ? { quantity: line.quantity } : {}),
    ...(line.measure ? { lengthFt: line.measure } : {}),
    ...(line.choices ? { modifiers: line.choices } : {}),
  };
}

function shownLines(pricing: QuotePricing): EstimateLine[] {
  return pricing.lineItems.filter((l) => l.selected).map((l) => ({ label: l.label, amountCents: l.amountCents, custom: l.custom }));
}

/**
 * Draft → priced estimate. Price-list lines are kept only if the price list can price them
 * (an unknown key or a manual-quote item falls back to the model's custom amount when it gave
 * one, else is dropped with an assumption). Custom amounts must be sane. Nothing priceable →
 * questions for the customer instead.
 */
export async function priceDraft(
  deps: Pick<EstimatorDeps, "priceQuote">,
  facts: Pick<BusinessFacts, "companyId" | "businessName" | "priceList">,
  draft: EstimateDraft,
  fallbackTitle: string,
): Promise<PricedEstimate> {
  if (!draft.enoughInfo) return { ok: false, reason: "too_vague", questions: draft.questions.length ? draft.questions : FALLBACK_QUESTIONS };
  const known = new Map(facts.priceList.map((p) => [p.key, p]));
  const services: EstimateService[] = [];
  const customLines: EstimateCustomLine[] = [];
  const assumptions = [...draft.assumptions];

  const asCustom = (label: string | null, amount: number | null): boolean => {
    const clean = cleanLineLabel(label, facts.businessName);
    if (!clean || amount == null || amount < MIN_CUSTOM_LINE_CENTS || amount > MAX_CUSTOM_LINE_CENTS) return false;
    customLines.push({ label: clean, amountCents: Math.round(amount) });
    return true;
  };

  for (const line of draft.lines) {
    if (line.serviceKey && known.has(line.serviceKey)) {
      const service = toService({ serviceKey: line.serviceKey, quantity: line.quantity, measure: line.measure, choices: line.choices });
      try {
        await deps.priceQuote(facts.companyId, { services: [service], customLines: [] });
        services.push(service);
        continue;
      } catch {
        const label = line.label ?? known.get(line.serviceKey)?.label ?? null;
        if (!asCustom(label, line.amountCents)) assumptions.push(`Couldn't price "${clip(known.get(line.serviceKey)?.label ?? line.serviceKey, 40)}" from the price list - left out`);
        continue;
      }
    }
    asCustom(line.label ?? line.serviceKey, line.amountCents);
  }

  if (services.length === 0 && customLines.length === 0) {
    return { ok: false, reason: "unpriceable", questions: draft.questions.length ? draft.questions : FALLBACK_QUESTIONS };
  }
  const pricing = await deps.priceQuote(facts.companyId, { services, customLines });
  return {
    ok: true,
    estimate: {
      title: cleanLineLabel(draft.title, facts.businessName) ?? fallbackTitle,
      lines: shownLines(pricing),
      services,
      customLines,
      subtotalCents: pricing.subtotalCents,
      taxCents: pricing.taxCents,
      totalCents: pricing.totalCents,
      confidence: draft.confidence,
      assumptions: assumptions.slice(0, 4),
      questions: draft.questions.slice(0, 3),
    },
  };
}

/**
 * The owner's text for an ai_estimate approval, built in CODE from the priced estimate (never
 * from the model's prose): who, what they asked, each line + amount, the total + HST, the
 * confidence and the assumptions. The notify step adds "#12" and the reply line
 * (front-desk/approval-text.ts replyInstruction: Y sends it, Y + a price changes the total). PURE.
 */
export function buildEstimateSummary(input: {
  customerName: string;
  customerPhone: string | null;
  description: string;
  photoCount: number;
  estimate: EstimateJson;
}): string {
  const phone = prettyPhone(input.customerPhone);
  const who = phone && input.customerName !== input.customerPhone && !input.customerName.replace(/\D/g, "").endsWith(phone.replace(/\D/g, "")) ? `${input.customerName} (${phone})` : phone ?? input.customerName;
  const e = input.estimate;
  const photos = input.photoCount > 0 ? ` + ${input.photoCount} photo${input.photoCount === 1 ? "" : "s"}` : "";
  const lines = e.lines.map((l) => `${clip(l.label, 50)} ${dollars(l.amountCents)}`).join("; ");
  const core = `AI estimate for ${who}: ${lines} = ${dollars(e.subtotalCents)} + HST (${dollars(e.totalCents)} total). Confidence: ${e.confidence}.`;
  let room = MAX_ESTIMATE_SUMMARY - core.length;
  const parts: string[] = [];
  if (e.assumptions.length && room > 40) {
    const a = ` Assumed: ${clip(e.assumptions.join("; "), Math.min(160, room - 2))}.`;
    parts.push(a);
    room -= a.length;
  }
  if (room > 40) parts.push(` They said: "${clip(input.description, Math.min(140, room - 16))}"${photos}.`);
  return `${core}${parts.join("")}`.slice(0, MAX_ESTIMATE_SUMMARY);
}

export interface RepricePlan {
  services: EstimateService[];
  customLines: EstimateCustomLine[];
  /** How the owner's number was applied (for the result detail / docs). */
  method: "scaled_custom_lines" | "single_line";
}

/**
 * "Y 12 $900": the quote's total before HST becomes exactly the owner's number.
 *
 * Price-list lines keep their list price (a quote showing a listed service at a different price
 * would contradict the price list the customer may already have seen); the change goes onto the
 * estimated (custom) lines, scaled in proportion, the last line taking the rounding. When there
 * are no estimated lines, or the owner's number doesn't leave a positive amount for them after
 * the price-list lines, the quote becomes ONE line — the estimate's title — at the owner's
 * price. `catalogSubtotalCents` is the price-list lines priced alone. PURE.
 */
export function planOwnerPrice(estimate: Pick<EstimateJson, "title" | "services" | "customLines">, ownerCents: number, catalogSubtotalCents: number): RepricePlan {
  const customTotal = estimate.customLines.reduce((a, l) => a + l.amountCents, 0);
  const room = ownerCents - (estimate.services.length ? catalogSubtotalCents : 0);
  if (estimate.customLines.length === 0 || customTotal <= 0 || room < MIN_CUSTOM_LINE_CENTS * estimate.customLines.length) {
    return { services: [], customLines: [{ label: estimate.title, amountCents: ownerCents }], method: "single_line" };
  }
  const scaled: EstimateCustomLine[] = [];
  let used = 0;
  estimate.customLines.forEach((line, i) => {
    const last = i === estimate.customLines.length - 1;
    const amount = last ? room - used : Math.max(MIN_CUSTOM_LINE_CENTS, Math.round((line.amountCents * room) / customTotal));
    used += amount;
    scaled.push({ label: line.label, amountCents: amount });
  });
  if (scaled.some((l) => l.amountCents < MIN_CUSTOM_LINE_CENTS)) {
    return { services: [], customLines: [{ label: estimate.title, amountCents: ownerCents }], method: "single_line" };
  }
  return { services: estimate.services, customLines: scaled, method: "scaled_custom_lines" };
}
