import { NextResponse } from "next/server";
import { z } from "zod";

import { handleRoute, parseJsonBody } from "@/server/api/route";
import { isAIConfigured } from "@/server/ai/claude";
import { callHelpModel } from "@/server/ai/help-assistant";
import { requireOrganizationContext } from "@/server/organizations/context";
import { loadHelpAccountContext } from "@/server/services/help/account-context";
import { askHelp, chatTurnSchema, MAX_QUESTION_CHARS } from "@/server/services/help/assistant";
import { enforceHelpAskLimits } from "@/server/services/help/limits";
import { recordHelpChatEvent } from "@/server/services/help/support";
import { recordAiUsageSafe } from "@/server/services/usage";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: { organizationId: string };
}

const bodySchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  history: z.array(chatTurnSchema).max(40).default([]),
  sessionId: z.string().uuid().optional(),
});

/**
 * In-app Help assistant (docs/help-assistant.md). Org members only. Answers from the
 * shipped help articles plus the caller's OWN light account context (plan, setup progress)
 * — read on their RLS client, scoped to the org they just proved membership of. Rate-limited
 * per user and per org; AI usage is metered to the org.
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  return handleRoute(async () => {
    const supabase = createSupabaseServerClient();
    const organization = await requireOrganizationContext(supabase, context.params.organizationId);
    const body = await parseJsonBody(request, bodySchema);

    const limited = await enforceHelpAskLimits(request, {
      userId: organization.user.id,
      organizationId: organization.organizationId,
    });
    if (limited) return limited;

    const ctx = { actorProfileId: organization.user.id, organizationId: organization.organizationId, supabase };
    const account = await loadHelpAccountContext(ctx, organization.membership.role ?? null);

    const result = await askHelp(
      { question: body.question, history: body.history, account },
      {
        callModel: isAIConfigured() ? callHelpModel : null,
        recordUsage: (usage) =>
          recordAiUsageSafe({ organizationId: organization.organizationId, companyId: null, ...usage }),
      },
    );

    await recordHelpChatEvent(ctx, {
      eventType: result.fallback === "ai_error" ? "error" : result.status,
      sessionId: body.sessionId ?? null,
      metadata: {
        retrieved: result.retrieved,
        cited: result.sources.map((s) => s.id),
        modelCalled: result.modelCalled,
        ...(result.fallback ? { fallback: result.fallback } : {}),
      },
    });

    return NextResponse.json({
      data: { status: result.status, answer: result.answer, sources: result.sources },
    });
  });
}
