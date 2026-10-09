// ─────────────────────────────────────────────────────────────────────────────
// SANCTIONED EXCEPTION (service role): concierge console — AI phone actions. Registered into the
// concierge registry, so each runs only through runConciergeAction (requireOperator, strict zod
// input, ONE org + its own company, audit row first). docs/front-desk-ai.md → "## Phone answering".
// Loaded by services/concierge/register-all.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";

import { toJson } from "@/server/db/json";
import { ValidationError } from "@/server/organizations/context";
import { emptySchema, registerConciergeAction } from "@/server/services/concierge/actions";
import { MAX_INCLUDED_MINUTES, mergeCallAnsweringSettings, readCallAnsweringSettings } from "@/server/services/voice/answering-settings";
import { resyncReceptionistForContext } from "@/server/services/voice/resync";

export const VOICE_CONCIERGE_ACTIONS = ["resync_ai_receptionist", "set_ai_call_minutes"] as const;

registerConciergeAction({
  name: "set_ai_call_minutes",
  label: "Set AI call minutes (Catch / Close)",
  schema: z.object({ minutes: z.number().int().min(0).max(MAX_INCLUDED_MINUTES) }).strict(),
  async run(ctx, input) {
    const { data, error } = await ctx.admin
      .from("companies")
      .select("ai_settings")
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.companyId)
      .maybeSingle();
    if (error) throw new Error(`company lookup failed: ${error.message}`);
    const current = (data as { ai_settings: unknown } | null)?.ai_settings ?? {};
    const before = readCallAnsweringSettings(current, { crankleads: true }).includedMinutes;
    const next = mergeCallAnsweringSettings(current, { included_minutes: input.minutes });
    const { error: updateError } = await ctx.admin
      .from("companies")
      .update({ ai_settings: toJson(next) })
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.companyId);
    if (updateError) throw new Error(`update failed: ${updateError.message}`);
    return {
      message: `AI call minutes set to ${input.minutes}/month (was ${before}). Front Desk accounts use their plan's allowance instead.`,
      audit: { before, after: input.minutes },
    };
  },
});

registerConciergeAction({
  name: "resync_ai_receptionist",
  label: "Re-sync AI receptionist (prompt + tools)",
  schema: emptySchema,
  async run(ctx) {
    const outcome = await resyncReceptionistForContext(ctx.tenant, ctx.companyId);
    if (outcome.status !== "resynced") {
      throw new ValidationError("This company has no AI receptionist number yet — provision the number first.");
    }
    return {
      message: `AI receptionist re-synced (agent ${outcome.agentId}, number ${outcome.phoneNumber}): prompt, tools and call analysis are current.`,
      result: { agentId: outcome.agentId, phoneNumber: outcome.phoneNumber },
      audit: { agentId: outcome.agentId, llmId: outcome.llmId },
    };
  },
});
