/**
 * The SMS agent's `offer_service_plan`: when a customer asks about regular / seasonal / yearly
 * service, the business's active plans (name, price, visits, what's included) and the sign-up page
 * link (added to the reply). The agent never signs anyone up itself and never invents a plan,
 * price or discount: amounts come from this tool (vouched for the reply guard).
 */
import { z } from "zod";

import type { AgentTool } from "@/server/services/sms-agent/tools";
import { plansPageUrl } from "./links";
import { includedOf, listPlans } from "./plans";
import { monthsText, priceText } from "./schedule";
import { loadPlanCompany } from "./settings";

export const offerServicePlan: AgentTool<{ interest?: string }> = {
  name: "offer_service_plan",
  description:
    "This business's maintenance / service plans (regular visits on a schedule for one yearly or per-visit price) and the link to sign up. Use when the customer asks about regular, seasonal, yearly or ongoing service, a maintenance plan, or 'can you come every spring'. Only state plans and prices this tool returned; the link goes in your reply.",
  inputSchema: {
    type: "object",
    properties: { interest: { type: "string", description: "What they want done regularly, in a few words (optional)." } },
    additionalProperties: false,
  },
  parse: z.object({ interest: z.string().max(200).optional() }),
  async run(state) {
    const company = await loadPlanCompany(state.admin, state.facts.organizationId, state.facts.companyId);
    if (!company || !company.crankleads || !company.settings.enabled) {
      return { ok: false, error: "This business doesn't offer service plans by text. If they want regular visits, use hand_off_to_owner." };
    }
    const plans = await listPlans(state.admin, company, { activeOnly: true });
    if (plans.length === 0) return { ok: false, error: "No service plans are set up. If they want regular visits, use hand_off_to_owner." };
    const link = await plansPageUrl(state.admin, company);
    for (const p of plans) state.effects.allowedAmountsCents.add(p.price_cents);
    if (link && !state.effects.links.includes(link)) state.effects.links.push(link);
    return {
      ok: true,
      plans: plans.slice(0, 5).map((p) => ({
        name: p.name,
        price: `${priceText(p.price_cents, p.billing)} + HST`,
        billing: p.billing === "annual" ? "paid once a year, up front" : "each visit is invoiced",
        visits: monthsText(p.visit_months),
        includes: includedOf(p),
      })),
      signup_link: link,
      note: link
        ? "Tell them briefly about the plan(s) and that they can sign up at the link (it's added to your reply). Don't sign them up yourself or promise a date or a discount."
        : "There's no sign-up page yet: tell them about the plan(s) and that the owner will set it up, then call hand_off_to_owner.",
    };
  },
};
